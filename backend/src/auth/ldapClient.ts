import { Client, Filter } from 'ldapts';
import { createHash } from 'node:crypto';
import { decryptSecret } from './secretCrypto.js';
import { createLogger } from '../config/logger.js';
import type { LdapConfigRecord, PasswordEncoderType } from '../db/ldapConfigStore.js';

const log = createLogger('ldapClient');

/**
 * v3.0 Faz 2.4 — gerçek LDAP BIND doğrulaması + kullanıcı bulma.
 *
 * NEDEN "ldapts" (ilk yazımda "ldapjs" idi, DÜZELTİLDİ): kullanıcı `npm install` çalıştırdığında
 * ldapjs'in "This package has been decomissioned" (kullanımdan tamamen kaldırıldı — bakımcısı
 * tacizkar bir e-posta aldıktan sonra projeyi bıraktı, "yeni hiçbir projede kullanmayın" tavsiyesi
 * yayınlandı, düzeltilmemiş güvenlik açıkları var) uyarısını gördü ve bunu bana iletti. Araştırınca
 * (bkz. socket.dev duyurusu) "ldapts"in — TAM TypeScript ile yeniden yazılmış, aktif bakımı süren,
 * Promise tabanlı (ldapjs'in eski callback/EventEmitter API'sinin AKSİNE) — standart, önerilen
 * halef olduğu görüldü. Kod HENÜZ hiç test edilmediği (ldapjs de bu sandbox'ta 403 ile engelliydi,
 * kullanıcı henüz gerçek bir LDAP sunucusuna karşı denememişti) için "batık maliyet" yoktu, bu
 * yüzden ilk üründen ÖNCE doğru pakete geçildi.
 *
 * ÖNEMLİ — DÜRÜST NOT: "ldapts" de "oracledb"/"ldapjs" ile AYNI şekilde bu geliştirme sandbox'ında
 * npm registry'den 403 ile ENGELLENİYOR, yani bu dosya BURADA GERÇEK BİR LDAP SUNUCUSUNA KARŞI
 * ÇALIŞTIRILAMADI/TEST EDİLEMEDİ — sadece resmi API dokümantasyonu incelenerek yazıldı. İlk gerçek
 * testte (kullanıcının kendi makinesinde) beklenmeyen bir hata çıkarsa, TAM hata mesajı bana
 * iletildiğinde hızlıca düzeltilebilir.
 *
 * İKİ KİMLİK DOĞRULAMA STRATEJİSİ desteklenir — admin panelde girilen alanlara göre otomatik seçilir:
 *
 * 1) DOĞRUDAN BIND (USER_DN_PATTERN dolu VE PASSWORD_ENCODER_TYPE='NO' iken): kullanıcı adını
 *    pattern'e yerleştirip (ör. "uid={0},ou=people,dc=example,dc=com") o DN ile DOĞRUDAN
 *    kullanıcının kendi şifresiyle bind denenir — Manager hesabına HİÇ GEREK YOKTUR, en yaygın ve
 *    en güvenli yöntemdir (LDAP sunucusu şifreyi kendi doğrular, biz asla göremeyiz/saklamayız).
 *
 * 2) MANAGER BIND + ARAMA (diğer TÜM durumlarda): önce Manager DN/Password ile bağlanılır.
 *    - USER_DN_PATTERN varsa: DN doğrudan hesaplanır, sadece öznitelikleri (userPassword dahil)
 *      okumak için o DN üzerinde bir arama yapılır.
 *    - YOKSA: USER_SEARCH_FILTER (ör. "(uid={0})") ile BASE_DN altında kullanıcı aranır.
 *    Sonra: PASSWORD_ENCODER_TYPE='NO' ise bulunan DN ile kullanıcının şifresiyle normal bind
 *    denenir (arama-sonra-bind deseni); DEĞİLSE (PLAIN/SHA/LDAP_SHA/MD4/MD5) "userPassword"
 *    özniteliği okunup encoder'a göre yerelde hash'lenerek karşılaştırılır (bazı eski/özel LDAP
 *    sunucuları basit bind'e izin vermez — bu yüzden bu alan admin panelde AYRICA istendi).
 *
 * GRUP BİLGİSİ (GROUP_SEARCH_BASE/GROUP_SEARCH_FILTER) BİLİNÇLİ OLARAK rol atamasını ETKİLEMEZ:
 * kullanıcının sohbette net belirttiği kural şu — "giriş yapılan kişiler ilk önce default olarak
 * normal user rolünde atanacak, admin isterse admin yapacak" — yani grup üyeliğinden otomatik
 * ADMIN türetmek İSTENMEDİ. Bu alanlar yine kaydedilir/okunur ama şu an kimlik doğrulama akışında
 * KULLANILMAZ.
 */

export interface LdapAuthSuccess {
  success: true;
  dn: string;
  displayName: string | null;
}

export interface LdapAuthFailure {
  success: false;
  /** SADECE loglama/hata ayıklama içindir — auth.ts bunu KULLANICIYA ASLA aynen göstermemeli
   * (enumeration/bilgi sızıntısını önlemek için route katmanı hep aynı genel mesajı döner). */
  reason: string;
}

export type LdapAuthResult = LdapAuthSuccess | LdapAuthFailure;

function createLdapClient(url: string): Client {
  return new Client({
    url,
    connectTimeout: 10000,
    timeout: 10000,
  });
}

interface FoundEntry {
  dn: string;
  displayName: string | null;
  /** Sadece encoder 'NO' DIŞINDA istendiğinde okunur (bkz. searchUser çağrıları). */
  userPassword: string | null;
}

/** ldapts'in Attribute nesnesinden ilk değeri okur — değer string DEĞİLSE (ör. binary Buffer)
 * utf-8 metne çevrilir. Hiç değer yoksa null döner. */
function firstAttributeValue(values: unknown): string | null {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const first: unknown = values[0];
  if (typeof first === 'string') return first;
  if (Buffer.isBuffer(first)) return first.toString('utf-8');
  return first === undefined || first === null ? null : String(first);
}

async function searchUser(
  client: Client,
  baseDn: string,
  filter: string,
  needUserPassword: boolean,
): Promise<FoundEntry | null> {
  const attributes = needUserPassword ? ['dn', 'cn', 'displayName', 'userPassword'] : ['dn', 'cn', 'displayName'];

  const { searchEntries } = await client.search(baseDn, { scope: 'sub', filter, attributes });
  const entry = searchEntries[0];
  if (!entry) {
    return null;
  }

  const getAttr = (name: string): string | null => {
    const attrEntry = (entry.attributes ?? []) as Array<{ type: string; values: unknown }>;
    const found = attrEntry.find((a) => a?.type?.toLowerCase() === name.toLowerCase());
    if (found) return firstAttributeValue(found.values);
    // ldapts ayrıca her özniteliği DOĞRUDAN entry üzerinde de düz alan olarak sunar (ör.
    // entry.cn, entry.displayName) — attributes dizisinde bulunamazsa buna da bakılır (savunmacı).
    const direct = (entry as unknown as Record<string, unknown>)[name];
    if (typeof direct === 'string') return direct;
    if (Array.isArray(direct)) return firstAttributeValue(direct);
    return null;
  };

  return {
    dn: String(entry.dn),
    displayName: getAttr('displayName') ?? getAttr('cn'),
    userPassword: needUserPassword ? getAttr('userPassword') : null,
  };
}

/** userPassword özniteliği, encoder tipine göre "{PREFIX}base64..." formatında saklanır (RFC 2307
 * benzeri) — bu yüzden karşılaştırmadan ÖNCE olası "{XXX}" önekini ayıklıyoruz (case-insensitive). */
function stripEncodingPrefix(stored: string): string {
  const match = stored.match(/^\{[A-Za-z0-9_]+\}(.*)$/s);
  return match?.[1] ?? stored;
}

/** MD4 Node'un GÜNCEL OpenSSL sürümlerinde (3.x) VARSAYILAN OLARAK KAPALI olabilir (legacy/eski bir
 * algoritma) — bu durumda createHash('md4') fırlatır, bunu net bir hata mesajına çeviriyoruz. */
function hashWith(algorithm: 'sha1' | 'md5' | 'md4', input: string): Buffer {
  try {
    return createHash(algorithm).update(input, 'utf-8').digest();
  } catch (err) {
    throw new Error(
      `LDAP şifre karşılaştırması için "${algorithm}" hash algoritması bu Node.js kurulumunda ` +
        `desteklenmiyor (muhtemelen OpenSSL 3.x'in legacy provider'ı etkin değil): ${(err as Error).message}`,
    );
  }
}

function passwordMatchesEncoder(rawPassword: string, storedValue: string, encoder: PasswordEncoderType): boolean {
  const value = stripEncodingPrefix(storedValue);

  switch (encoder) {
    case 'PLAIN':
      return rawPassword === value;

    case 'MD5': {
      const computed = hashWith('md5', rawPassword).toString('base64');
      return computed === value;
    }

    case 'MD4': {
      const computed = hashWith('md4', rawPassword).toString('base64');
      return computed === value;
    }

    case 'SHA': {
      // Unsalted {SHA} — base64(sha1(password)).
      const computed = hashWith('sha1', rawPassword).toString('base64');
      return computed === value;
    }

    case 'LDAP_SHA': {
      // Salted {SSHA} — base64(sha1(password + salt) + salt), salt = decoded değerin SHA1 digest
      // uzunluğundan (20 byte) SONRAKİ kısım (yaygın "salted SHA" formatı).
      const decoded = Buffer.from(value, 'base64');
      const SHA1_LENGTH = 20;
      if (decoded.length <= SHA1_LENGTH) {
        return false;
      }
      const digest = decoded.subarray(0, SHA1_LENGTH);
      const salt = decoded.subarray(SHA1_LENGTH);
      const computed = createHash('sha1').update(Buffer.concat([Buffer.from(rawPassword, 'utf-8'), salt])).digest();
      return computed.equals(digest);
    }

    case 'NO':
    default:
      // Buraya normalde düşülmemeli (NO iken doğrudan bind kullanılır, bkz. authenticateAgainstLdap).
      return false;
  }
}

/**
 * Ana giriş noktası — bkz. dosya başı NOT (iki strateji). config.url / config.baseDn eksikse ya da
 * (userDnPattern VE userSearchFilter) ikisi de boşsa "yapılandırma eksik" hatasıyla başarısız
 * döner — LDAP sunucusuna hiç bağlanmaya ÇALIŞILMAZ.
 */
export async function authenticateAgainstLdap(
  username: string,
  password: string,
  config: LdapConfigRecord,
): Promise<LdapAuthResult> {
  if (!config.url || !config.baseDn) {
    return { success: false, reason: 'LDAP yapılandırması eksik (URL veya Base DN girilmemiş).' };
  }
  if (!config.userDnPattern && !config.userSearchFilter) {
    return { success: false, reason: 'LDAP yapılandırmasında ne User DN Pattern ne de User Search Filter tanımlı.' };
  }

  // Filter.escape() — ldapts'in RFC4515 uyumlu kaçış (escape) yardımcısı. Kullanıcı adı hem arama
  // filtrelerinde hem DN pattern'inde DOĞRUDAN kullanıcı girdisi olduğu için BUNUN OLMAMASI bir
  // LDAP injection açığı olurdu (ör. "*)(uid=*))(|(uid=*" gibi bir kullanıcı adıyla filtreyi
  // manipüle etmek).
  const escapedUsername = Filter.escape(username);
  const encoder = config.passwordEncoderType;
  const client = createLdapClient(config.url);

  try {
    // STRATEJİ 1 — doğrudan bind: sadece DN pattern VARSA ve encoder 'NO' İSE, manager'a hiç
    // gerek kalmadan en kısa/güvenli yoldan gidilir.
    if (config.userDnPattern && encoder === 'NO') {
      const userDn = config.userDnPattern.replace('{0}', escapedUsername);
      await client.bind(userDn, password);
      // Görünen isim burada bilinmiyor (arama yapılmadı) — userStore tarafı bunu null iken
      // username'e düşürür (bkz. auth.ts çağrı yeri).
      return { success: true, dn: userDn, displayName: null };
    }

    // STRATEJİ 2 — manager bind gerekiyor (DN pattern yok VEYA şifre karşılaştırma modundayız).
    if (!config.managerDn || !config.managerPasswordEncrypted) {
      return { success: false, reason: 'Manager DN/Password gerekiyor ama yapılandırılmamış.' };
    }
    const managerPassword = decryptSecret(config.managerPasswordEncrypted);
    if (managerPassword === null) {
      return { success: false, reason: 'Kaydedilmiş Manager Password çözülemedi (şifreleme anahtarı değişmiş olabilir).' };
    }
    await client.bind(config.managerDn, managerPassword);

    let userDn: string;
    let displayName: string | null;
    let userPasswordAttr: string | null;

    if (config.userDnPattern) {
      // DN pattern var ama encoder 'NO' değil — DN hesaplanır, sadece öznitelikleri (userPassword
      // dahil) okumak için o DN üzerinde bir arama yapılır.
      userDn = config.userDnPattern.replace('{0}', escapedUsername);
      const found = await searchUser(client, userDn, '(objectClass=*)', true);
      displayName = found?.displayName ?? null;
      userPasswordAttr = found?.userPassword ?? null;
    } else {
      if (!config.userSearchFilter) {
        return { success: false, reason: 'User Search Filter tanımlı değil.' };
      }
      const filter = config.userSearchFilter.replace('{0}', escapedUsername);
      const found = await searchUser(client, config.baseDn, filter, encoder !== 'NO');
      if (!found) {
        return { success: false, reason: 'Kullanıcı LDAP dizininde bulunamadı.' };
      }
      userDn = found.dn;
      displayName = found.displayName;
      userPasswordAttr = found.userPassword;
    }

    if (encoder === 'NO') {
      // Arama-sonra-bind: manager bağlantısı ÜZERİNDEN, bulunan DN ile kullanıcının KENDİ
      // şifresiyle YENİDEN bind denenir (LDAP protokolünde bir bağlantı üzerinde ardışık bind
      // çağrıları o bağlantıyı YENİ kimlikle yeniden doğrular — standart "search-then-bind" deseni).
      await client.bind(userDn, password);
      return { success: true, dn: userDn, displayName };
    }

    if (!userPasswordAttr) {
      return { success: false, reason: 'Bulunan girdide userPassword özniteliği okunamadı.' };
    }
    if (!passwordMatchesEncoder(password, userPasswordAttr, encoder)) {
      return { success: false, reason: 'Şifre karşılaştırması eşleşmedi.' };
    }
    return { success: true, dn: userDn, displayName };
  } catch (err) {
    const message = (err as Error).message;
    log.info({ username, err: message }, 'LDAP kimlik doğrulama başarısız');
    return { success: false, reason: message };
  } finally {
    try {
      await client.unbind();
    } catch (err) {
      log.warn({ err }, 'LDAP bağlantısı kapatılırken hata (görmezden gelindi)');
    }
  }
}
