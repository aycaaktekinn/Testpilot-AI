import { SeleniumGridError } from '../../domain/errors.js';
import { createLogger } from '../../config/logger.js';
import { env } from '../../config/env.js';

const log = createLogger('SeleniumGridClient');

/** Grid hub'a bağlanma/session açma işlemi bu süreden uzun sürerse iptal edilir. */
const SESSION_CREATE_TIMEOUT_MS = 30_000;
/** Session kapatma (release) best-effort'tur; kısa bir sınır yeterlidir. */
const SESSION_DELETE_TIMEOUT_MS = 10_000;

export interface GridSession {
  sessionId: string;
  /** Playwright'ın chromium.connectOverCDP()'ye vereceği CDP WebSocket adresi. */
  cdpUrl: string;
  /**
   * v2.2 — SADECE `env.SELENIUM_GRID_NODE_VNC_MAP`'te bu node için bir eşleme VARSA doludur (bkz.
   * env.ts dosya başı açıklaması) — kullanıcının bu session'ı tarayıcısından CANLI izleyebileceği
   * noVNC adresi (ör. "http://localhost:6081"). Eşleme yoksa (varsayılan) `undefined`'dır — bu
   * durumda run normal şekilde çalışır, sadece canlı izleme linki üretilmez.
   */
  liveViewUrl?: string;
}

/**
 * Bir Selenium Grid 4 hub'ıyla, ham W3C WebDriver REST protokolü üzerinden konuşan küçük bir
 * istemci — herhangi bir "selenium-webdriver" paketi KULLANILMIYOR (bu projenin tek WebDriver
 * ihtiyacı, Grid'in bir node'unda oturum açıp oradan Playwright'ın bağlanabileceği CDP adresini
 * almaktan ibaret; tam bir WebDriver istemcisi gereksiz bir bağımlılık olurdu).
 *
 * AKIŞ: `createSession()` hub'da `POST /session` ile bir Chrome/Chromium session'ı ister. Selenium
 * Grid 4, Chrome/Edge tabanlı node'lar için dönen capabilities içine otomatik olarak `se:cdp`
 * alanını (o SPESİFİK session'ın CDP WebSocket adresi) ekler — BrowserManager bu adresle
 * `chromium.connectOverCDP()` çağırır. Run bittiğinde `deleteSession()` ile `DELETE
 * /session/:id` çağrılıp node Grid havuzuna GERİ BIRAKILMALIDIR; aksi halde node süresiz "meşgul"
 * görünür ve havuzdan asla geri dönmez.
 */
export class SeleniumGridClient {
  constructor(private readonly hubUrl: string) {}

  async createSession(targetUrl?: string): Promise<GridSession> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SESSION_CREATE_TIMEOUT_MS);

    // v3.24 — VakıfBank'ın kendi Java/Selenium (RemoteWebDriver) testlerinde AYNI Grid'e karşı
    // KANITLANMIŞ ŞEKİLDE ÇALIŞAN ChromeOptions'tan uyarlandı (bkz. sohbette paylaşılan
    // `capabilitiesForRemote()`). Java tarafı standart WebDriver protokolüyle TÜM komutları
    // (navigasyon dahil) hub üzerinden PROXY'LER — bu yüzden onun başarılı çalışması, hub-node
    // ağ erişilebilirliğiyle ilgili SORUNUMUZU (connectOverCDP'nin node'a DOĞRUDAN bağlanma
    // ihtiyacı) KANITLAMAZ/ÇÖZMEZ (bkz. rewriteHostInUrl v3.23 NOT'u — o ayrı ve GEREKLİ bir
    // düzeltmeydi). Ama BİR KERE bağlantı kurulduktan SONRA Chrome'un `.intra` sertifikasıyla/
    // orijiniyle nasıl davrandığı ORTAK bir sorun — bu yüzden aşağıdaki flag'ler buradan alındı.
    const insecureOriginArg = this.buildInsecureOriginArg(targetUrl);

    let response: Response;
    try {
      response = await fetch(this.sessionEndpoint(), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        // W3C WebDriver "New Session" isteği — SADECE Chrome/Chromium isteniyor (bkz. dosya başı
        // açıklaması: Grid'in CDP relay'i, protokol düzeyinde SADECE Chromium-ailesi tarayıcılarda
        // vardır).
        body: JSON.stringify({
          capabilities: {
            alwaysMatch: {
              browserName: 'chrome',
              // v3.22 -- VakifBank ic agindaki (.intra) HTTPS adresleri genelde kurumsal/ic CA
              // imzali sertifikalar kullanir; bu sertifikalar Grid node'unun guvenilir kok
              // sertifika deposunda OLMAYABILIR. Bu durumda Chrome navigasyonu tamamlanmadan
              // "Baglantiniz ozel degil" interstitial uyarisinda TAKILI KALIR -- CDP uzerinden bu
              // uyari otomatik gecilemez, adres cubugunda "data:," gorunmeye devam eder.
              // acceptInsecureCerts + asagidaki Chrome flag'leri, gecersiz/guvenilmeyen
              // sertifikalari SESSIZCE kabul ederek bu interstitial'i bastan engeller.
              acceptInsecureCerts: true,
              'goog:chromeOptions': {
                args: [
                  '--ignore-certificate-errors',
                  '--ignore-ssl-errors',
                  '--allow-insecure-localhost',
                  '--allow-running-insecure-content',
                  // v3.24 — Java tarafındaki kanıtlanmış ayarlarla hizalandı.
                  '--disable-notifications',
                  '--disable-popup-blocking',
                  ...(insecureOriginArg ? [insecureOriginArg] : []),
                ],
                // v3.24 — "Chrome is being controlled by automated test software" banner'ını
                // gizler (Java tarafındaki excludeSwitches ile aynı) — kozmetik, testi etkilemez.
                excludeSwitches: ['enable-automation'],
              },
            },
          },
        }),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SeleniumGridError(
          `Selenium Grid hub'ı (${this.hubUrl}) ${SESSION_CREATE_TIMEOUT_MS}ms içinde yanıt vermedi. ` +
            'Hub adresi doğru mu ve Grid çalışıyor mu kontrol edin.',
        );
      }
      throw new SeleniumGridError(
        `Selenium Grid hub'ına (${this.hubUrl}) bağlanılamadı: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      log.error({ status: response.status, text }, "Grid hub'ı session isteğini reddetti");
      throw new SeleniumGridError(
        `Selenium Grid hub'ı session isteğini reddetti (HTTP ${response.status}). Grid'de boşta bir Chrome ` +
          `node'u olmayabilir. ${truncate(text, 300)}`,
      );
    }

    const json = (await response.json().catch(() => null)) as GridSessionResponse | null;
    const sessionId = json?.value?.sessionId;
    const cdpUrl = json?.value?.capabilities?.['se:cdp'];

    if (!sessionId) {
      throw new SeleniumGridError("Grid hub'ından geçerli bir sessionId alınamadı (beklenmeyen yanıt şekli).");
    }

    if (!cdpUrl) {
      // Session AÇILDI ama CDP adresi yoksa node'u hemen serbest bırakmalıyız — aksi halde havuzda
      // kalıcı olarak "meşgul" görünen, hiç kullanılamayacak bir session sızdırırız.
      await this.deleteSession(sessionId);
      throw new SeleniumGridError(
        "Grid hub'ı bir session açtı ama CDP adresi (se:cdp) döndürmedi — bu node Chrome/Chromium " +
          'tabanlı olmayabilir veya bu Grid sürümü CDP relay desteklemiyor olabilir.',
      );
    }

    // v2.1 — node'un GERÇEK Docker-içi adresini (host'tan CDP rewrite'ından ÖNCEKİ hali) burada
    // saklıyoruz — v2.2'de noVNC linkini de AYNI node kimliğinden (IP) türetmemiz gerekiyor, ve
    // aşağıdaki rewriteHostInUrl çağrısı `cdpUrl`'ü YERİNDE (in-place) değil, yeni bir string olarak
    // döndürür, yani orijinal IP'yi hâlâ `cdpUrl`'den okuyabiliriz.
    const originalNodeHost = this.extractHostname(cdpUrl);

    // v3.23 -- Grid ARTIK bu makinenin disinda, UZAK bir sunucuda calisiyor (ör. 10.30.165.144) --
    // node'un IP'sini bizim ELİMİZDE olan bir docker-compose.override.yml ile SABİTLEYEMİYORUZ, bu
    // yuzden SELENIUM_GRID_NODE_HOST_MAP'te (yerel gelistirme icin, sabit 172.28.0.11-15 IP'leri
    // icin yazilmis) bu node'un IP'si (ör. "172.18.0.6") ASLA bulunamayacak -- eskiden bu durumda
    // (harita tanimli ama eslesme yok) adres OLDUGU GIBI (erisilmez ic Docker IP'siyle) kullanilip
    // connectOverCDP 30sn sonra timeout aliyordu. FALLBACK: eslesme yoksa artik host kismini hub'in
    // KENDI adresiyle (10.30.165.144) DEGISTIRIYORUZ, PORTU ise oldugu gibi (node'un self-report
    // ettigi port, genelde hub ile AYNI -- bkz. asagidaki rewriteHostInUrl NOT'u) birakiyoruz. Bu,
    // hub+node'larin AYNI fiziksel sunucuda calistigi (ki port numarasi yukaridaki timeout log'unda
    // hub'inkiyle AYNI -- 4444 -- oldugu icin oyle oldugu ortada) en yaygin Grid-Docker kurulumu
    // icin dogru sonucu verir. Eger bir gun node'lar GERCEKTEN farkli bir sunucuda/portta olursa,
    // SELENIUM_GRID_NODE_HOST_MAP'e o node'un IP'si icin ACIK bir eslesme eklemek bu fallback'i
    // (oncelik hala haritada) GECERSIZ KILAR -- yani bu degisiklik var olan haritali akisi BOZMAZ.
    const gridHubHost = this.extractHostname(this.hubUrl) ?? undefined;

    const finalCdpUrl = this.rewriteHostInUrl(
      cdpUrl,
      env.SELENIUM_GRID_NODE_HOST_MAP,
      'SELENIUM_GRID_NODE_HOST_MAP',
      gridHubHost,
    );
    const liveViewUrl = originalNodeHost ? this.computeLiveViewUrl(originalNodeHost) : undefined;

    log.info({ sessionId, liveViewUrl }, "Selenium Grid session'ı açıldı");
    return { sessionId, cdpUrl: finalCdpUrl, liveViewUrl };
  }

  /**
   * v3.24 — Java tarafındaki `--unsafely-treat-insecure-origin-as-secure=<BASEURL>` flag'inin
   * karşılığı. `targetUrl` geçerli bir URL DEĞİLSE (ör. verilmediyse — bkz. BrowserManager.launch
   * targetUrl NOT'u, ya da parse edilemiyorsa) `undefined` döner ve flag HİÇ EKLENMEZ — davranış
   * eskisi gibi kalır. Sadece origin'i (protokol+host+port, path'siz) alır — Chrome bu flag'i tam
   * origin bekler.
   */
  private buildInsecureOriginArg(targetUrl: string | undefined): string | undefined {
    if (!targetUrl) return undefined;
    try {
      const origin = new URL(targetUrl).origin;
      return `--unsafely-treat-insecure-origin-as-secure=${origin}`;
    } catch (err) {
      log.warn({ err, targetUrl }, "Hedef URL'nin origin'i çıkarılamadı, --unsafely-treat-insecure-origin-as-secure eklenmiyor");
      return undefined;
    }
  }

  private extractHostname(url: string): string | null {
    try {
      return new URL(url).hostname;
    } catch (err) {
      log.warn({ err, url }, 'Adres ayrıştırılamadı');
      return null;
    }
  }

  /**
   * v2.1 — SADECE `mapEnvValue` (ör. `env.SELENIUM_GRID_NODE_HOST_MAP`) tanımlıysa bir şey yapar
   * (bkz. env.ts dosya başı açıklaması). Grid hub'ının döndürdüğü `se:cdp` adresi, node'un KENDİ
   * Docker-içi bridge network IP'sini içerir (ör. "172.28.0.11:4444") — backend Docker DIŞINDA (bu
   * makinenin üzerinde native) çalıştığında bu IP'ye ULAŞAMAZ.
   *
   * BİLİNÇLİ OLARAK burada `SE_NODE_HOST`/`SE_NODE_PORT`'A GÜVENİLMEZ: node'u doğrudan "localhost"
   * advertise etmesi için ayarlamak GÖRÜNÜŞTE basit bir çözüm gibi dursa da hub'ın KENDİSİNİN node'a
   * ulaşmasını (kayıt/health-check) BOZAR — "localhost" hub'ın kendi container'ından bakıldığında
   * hub'ın KENDİSİNE işaret eder, node'a değil (canlıda doğrulandı: kayıt sonsuz döngüye giriyordu).
   * Bu yüzden node'un kendi Docker-içi adresi HİÇ DEĞİŞTİRİLMEZ (hub-node kaydı bozulmasın diye);
   * bunun yerine bu SADECE İSTEMCİ TARAFINDA (burada, hub'dan yanıt aldıktan SONRA) bilinen sabit bir
   * IP → host portu haritasıyla adresi yeniden yazar — hub-node iletişimini hiç etkilemez.
   *
   * v2.2'de `SELENIUM_GRID_NODE_VNC_MAP` (noVNC linki) için de AYNI mantıkla, ayrı bir çağrıyla
   * kullanılır — bu yüzden hangi env değişkeninin kaynaklandığı (`mapEnvVarName`) sadece log
   * mesajlarında doğru ismi göstermek için parametre olarak alınır.
   */
  private rewriteHostInUrl(
    url: string,
    mapEnvValue: string | undefined,
    mapEnvVarName: string,
    fallbackHost?: string,
  ): string {
    const nodeHost = this.extractHostname(url);
    const replacement = mapEnvValue ? this.lookupReplacement(mapEnvValue, nodeHost, mapEnvVarName) : undefined;

    if (replacement) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch (err) {
        log.warn({ err, url }, 'Adres ayrıştırılamadı, olduğu gibi kullanılıyor');
        return url;
      }

      const [replacementHost, replacementPort] = replacement.split(':');
      if (!replacementHost) {
        log.warn({ mapEnvVarName, replacement }, '"host:port" formatında olmalı, adres olduğu gibi kullanılıyor');
        return url;
      }
      parsed.hostname = replacementHost;
      if (replacementPort) {
        parsed.port = replacementPort;
      }

      const rewritten = parsed.toString();
      log.debug({ from: url, to: rewritten }, "Adres host'tan erişilebilir olacak şekilde (haritadan) yeniden yazıldı");
      return rewritten;
    }

    // v3.23 — Harita TANIMLI DEĞİL ya da bu node için bir karşılığı YOK. `fallbackHost` verilmişse
    // (çağıran taraf hub'ın kendi host'unu geçiyor) VE dönen node adresi KLASİK bir Docker
    // bridge-içi IP'ye BENZİYORSA (172.16.0.0/12 — bkz. isDockerBridgeLikeIp), bunu hub'ın KENDİ
    // adresiyle (PORTU KORUYARAK) değiştiriyoruz — hub+node'ların aynı sunucuda/container'da
    // çalıştığı (canlıda gözlemlendi: dönen CDP portu hub'ınkiyle AYNIYDI — 4444) en yaygın
    // Grid-Docker kurulumu için doğru sonucu verir.
    //
    // BİLİNÇLİ OLARAK sadece 172.16.0.0/12'ye bakıyoruz (10.0.0.0/8 veya 192.168.0.0/16'ya DEĞİL):
    // VakıfBank gibi kurumsal ağlarda "gerçek", host'tan zaten doğrudan erişilebilir node'lar da
    // GAYET NORMAL şekilde 10.x adresler kullanabilir (ör. hub'ın kendisi 10.30.165.144) — böyle
    // bir adresi de "erişilemez" sayıp hub host'uyla ezmek, DOĞRU ÇALIŞAN bir çok-node kurulumunu
    // BOZAR. 172.16.0.0/12 ise Docker'ın hem varsayılan bridge ağının hem de bu projenin kendi
    // özel ağının (bkz. docker-compose.override.yml — 172.28.0.0/24) neredeyse her zaman kullandığı
    // aralıktır — bu yüzden "muhtemelen container-içi, host'tan erişilemez" için GÜVENİLİR bir
    // işaret sayılabilir.
    if (fallbackHost && nodeHost && isDockerBridgeLikeIp(nodeHost) && nodeHost !== fallbackHost) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch (err) {
        log.warn({ err, url }, 'Adres ayrıştırılamadı, olduğu gibi kullanılıyor');
        return url;
      }
      parsed.hostname = fallbackHost;
      const rewritten = parsed.toString();
      log.info(
        { nodeHost, fallbackHost, from: url, to: rewritten },
        "Node için haritada eşleme yok ve adres bir Docker bridge IP'sine benziyor — Grid hub'ının kendi adresiyle (port korunarak) yeniden yazıldı",
      );
      return rewritten;
    }

    if (!replacement && mapEnvValue) {
      log.warn(
        { nodeHost, mapEnvVarName },
        'Bu node için haritada bir eşleme bulunamadı, adres olduğu gibi kullanılıyor (host makineden erişilemeyebilir)',
      );
    }
    return url;
  }

  /**
   * v2.2 — hub'dan dönen yanıtta noVNC için bir alan YOKTUR (sadece `se:cdp` vardır) — bu yüzden
   * `rewriteHostInUrl`'ün aksine "var olan bir adresi düzeltme" değil, node'un IP'sinden SIFIRDAN
   * bir http(s) adresi ÜRETME işidir. `env.SELENIUM_GRID_NODE_VNC_MAP`'te bu node için bir eşleme
   * yoksa (varsayılan durum) `undefined` döner — canlı izleme linki üretilmez, run etkilenmez.
   */
  private computeLiveViewUrl(nodeHost: string): string | undefined {
    const replacement = this.lookupReplacement(env.SELENIUM_GRID_NODE_VNC_MAP, nodeHost, 'SELENIUM_GRID_NODE_VNC_MAP');
    return replacement ? `http://${replacement}` : undefined;
  }

  /** `lookupReplacement`: verilen JSON haritada `nodeHost` için bir "host:port" karşılığı arar. */
  private lookupReplacement(mapEnvValue: string | undefined, nodeHost: string | null, mapEnvVarName: string): string | undefined {
    if (!mapEnvValue || !nodeHost) {
      return undefined;
    }

    let map: Record<string, string>;
    try {
      map = JSON.parse(mapEnvValue) as Record<string, string>;
    } catch (err) {
      log.warn({ err, mapEnvVarName }, 'geçerli bir JSON değil, atlanıyor');
      return undefined;
    }

    return map[nodeHost];
  }

  /** Best-effort: node'u Grid havuzuna geri bırakır. Asla fırlatmaz — sadece loglar. */
  async deleteSession(sessionId: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SESSION_DELETE_TIMEOUT_MS);

    try {
      await fetch(this.sessionEndpoint(sessionId), { method: 'DELETE', signal: controller.signal });
      log.info({ sessionId }, "Selenium Grid session'ı serbest bırakıldı");
    } catch (err) {
      log.warn({ err, sessionId }, "Grid session'ı serbest bırakılamadı (node havuzda 'meşgul' kalmış olabilir)");
    } finally {
      clearTimeout(timer);
    }
  }

  private sessionEndpoint(sessionId?: string): string {
    const base = this.hubUrl.replace(/\/+$/, '');
    return sessionId ? `${base}/session/${sessionId}` : `${base}/session`;
  }
}

interface GridSessionResponse {
  value?: {
    sessionId?: string;
    capabilities?: Record<string, string | undefined> & { 'se:cdp'?: string };
  };
}

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

/**
 * v3.23 — `host`, Docker'ın klasik özel adres bloğu olan 172.16.0.0/12 içinde mi? (172.16.x.x —
 * 172.31.x.x). Bilerek SADECE bu aralığa bakılıyor (10.0.0.0/8 veya 192.168.0.0/16'ya DEĞİL) —
 * bkz. rewriteHostInUrl içindeki v3.23 NOT'u: kurumsal ağlarda 10.x/192.168.x adresler GERÇEKTEN
 * doğrudan erişilebilir olabilir (ör. bu projede Grid hub'ının kendisi 10.30.165.144), bu yüzden
 * onlara DOKUNULMAMASI gerekir — 172.16.0.0/12 ise container-içi bir adres için güvenilir bir
 * işarettir.
 */
function isDockerBridgeLikeIp(host: string): boolean {
  const match = host.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!match) return false;
  const secondOctet = Number(match[1]);
  return secondOctet >= 16 && secondOctet <= 31;
}
