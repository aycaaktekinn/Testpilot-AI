import type { Page } from 'playwright';
import { createLogger } from '../../config/logger.js';

const log = createLogger('ConsentBannerHandler');

/**
 * Gerçek dünyadaki birçok site (özellikle e-ticaret), sayfa yüklendikten SONRA — bazen birkaç
 * saniye gecikmeyle — bir çerez/KVKK/GDPR onay banner'ı gösterir. Bu banner genellikle sayfanın
 * geri kalanının ÜZERİNDE (yüksek z-index, "fixed"/"sticky" konum) durur. Playwright'ın
 * actionability kontrolü bir elemente tıklamadan/tuş basmadan ÖNCE "bu element gerçekten olayları
 * ALABİLİYOR mu" diye bakar; banner araya girdiğinde bu kontrol hiçbir zaman geçemez ve işlem
 * (hepsiburada.com üzerinde canlı olarak gözlemlendiği gibi) TIMEOUT ile başarısız olur — LLM'in
 * seçtiği element/aksiyon tamamen doğru olsa bile.
 *
 * Bu, LLM'in bilmesi/karar vermesi gereken bir "test senaryosu adımı" DEĞİL, sayfaya özgü geçici
 * bir engeldir. Bu yüzden bunu bir LLM kararı olarak sormak yerine (ekstra LLM çağrısı + gecikme +
 * "hangi elementi tıklamalıyım" belirsizliği) saf Playwright ile, LLM'e hiç danışmadan, otomatik
 * temizliyoruz — proje kuralı: LLM çağrılarını minimize et.
 *
 * GÜVENLİK TASARIMI (önemli, HER İKİ strateji için de geçerli): bu modül "OK", "Kabul Et", "Tamam"
 * gibi metne sahip HERHANGİ bir kontrole körü körüne tıklamaz — bu, sayfadaki alakasız bir onay/
 * uyarı diyaloğuna (örn. bir silme onayı) yanlışlıkla tıklanmasına yol açabilir ki bu projenin
 * "belirsiz elemente asla tıklama" güvenlik ilkesine aykırı olur. Her iki strateji de İKİ AŞAMALI
 * bir eşleştirme yapar: önce id/class'ında açıkça çerez/onay ile ilişkili bir anahtar kelime geçen
 * bir ELEMENT bulunur (yani sadece GERÇEKTEN bir çerez/onay mekanizması olduğu belli olan
 * elementlerle ilgilenilir), SONRA o elementin/içindeki bir kontrolün "kabul/onayla/accept/agree"
 * anlamına gelen bir metni olduğu doğrulanır. Böylece sayfanın başka bir yerindeki alakasız bir
 * "Tamam" butonuna asla dokunulmaz.
 *
 * Best-effort: banner yoksa neredeyse anında (birkaç ms) döner; herhangi bir hata sessizce
 * yutulur — bu yardımcı ASLA run'ı başarısız kılmamalı.
 */
const CONTAINER_HINTS = ['cookie', 'consent', 'kvkk', 'gdpr', 'onetrust', 'çerez', 'cerez'];

/**
 * v3.0 — STRATEJİ 2 (yeni, hepsiburada.com'da canlı olarak gözlemlenip doğrulandı): bazı
 * sitelerde onay KONTROLÜNÜN KENDİSİ id/class'ında doğrudan "kabul et/accept-all" niyetini
 * taşır — ama SARAN KAPSAYICISININ id/class'ında CONTAINER_HINTS'teki hiçbir kelime GEÇMEZ.
 * Somut örnek: `<div id="hb-accept-all">Kabul Et</div>` — dikkat, bu bir <button>/<a> DEĞİL,
 * düz bir <div>. STRATEJİ 1 bu durumu İKİ nedenle KAÇIRIR: (a) sarıcı kapsayıcı CONTAINER_HINTS
 * ile eşleşmediği için arama hiç başlamaz, (b) buton araması sadece <button>/<a>/[role="button"]/
 * input[type=button|submit] etiketlerine bakar, düz bir <div>'i hiç görmez. Bu strateji,
 * KAPSAYICIYA bakmak yerine DOĞRUDAN kontrolün KENDİ id/class'ında net bir "kabul et" niyeti
 * arar (herhangi bir etiket türü dahil, <div>/<span> de olabilir). Güvenlik ilkesi AYNI kalır
 * (bkz. dosya başı NOT) — sadece somut bir isim eşleşmesi + doğru metin varsa tıklanır.
 */
const DIRECT_ELEMENT_HINTS = ['accept-all', 'acceptall', 'accept_all', 'kabul-et', 'kabuletbtn'];

// Dışa aktarılıyor: InterceptingOverlayHandler.ts, GEOMETRİK olarak doğrulanmış (document.
// elementFromPoint ile "gerçekten neyin altımı engellediği" tespit edilmiş) bir engelleyici öğe
// içinde AYNI deseni arayabilsin diye (bkz. o dosyadaki dosya başı NOT — bu, keyword/class-adı
// tahminine hiç gerek duymayan, SİTE BAĞIMSIZ genel çözümdür).
export const ACCEPT_TEXT_PATTERN =
  /(kabul et|tümünü kabul et|hepsini kabul et|onayla|kabul ediyorum|accept all|accept cookies|^accept$|i agree|^agree$|allow all|got it)/i;

export async function dismissConsentBanners(page: Page): Promise<void> {
  try {
    if (await tryContainerBasedDismiss(page)) return;
    await tryDirectElementDismiss(page);
  } catch (err) {
    // Kasıtlı: bu yardımcı asla run'ı etkilememeli, sadece "varsa temizle, yoksa dokunma".
    log.debug({ err }, 'Onay banner temizleme adımı atlandı (hata oluştu, zararsız)');
  }
}

/** STRATEJİ 1 (orijinal): önce çerez/onay ile ilişkili bir KAPSAYICI bulunur, sonra içindeki
 * kabul butonuna tıklanır. Bir şey tıklandıysa `true` döner. */
async function tryContainerBasedDismiss(page: Page): Promise<boolean> {
  const containerSelector = CONTAINER_HINTS.map((hint) => `[class*="${hint}" i], [id*="${hint}" i]`).join(', ');
  const containers = page.locator(containerSelector);
  const containerCount = await containers.count().catch(() => 0);
  if (containerCount === 0) return false;

  // Çok sayıda eşleşme normal değildir (genelde 1-2 tanedir); makul bir üst sınırla tarıyoruz.
  for (let i = 0; i < Math.min(containerCount, 5); i++) {
    const container = containers.nth(i);
    const containerVisible = await container.isVisible({ timeout: 200 }).catch(() => false);
    if (!containerVisible) continue;

    const acceptButton = container
      .locator('button, a, [role="button"], input[type="button"], input[type="submit"]')
      .filter({ hasText: ACCEPT_TEXT_PATTERN })
      .first();
    const buttonVisible = await acceptButton.isVisible({ timeout: 200 }).catch(() => false);
    if (!buttonVisible) continue;

    await acceptButton.click({ timeout: 1500 }).catch(() => {});
    log.debug({ containerIndex: i }, 'Onay/çerez banner otomatik kapatıldı (kapsayıcı eşleşmesi, LLM çağrısı yapılmadı)');
    return true;
  }
  return false;
}

/** STRATEJİ 2 (yeni, bkz. DIRECT_ELEMENT_HINTS dosya başı NOT): kapsayıcıya bakmadan, doğrudan
 * id/class'ında "accept-all" gibi net bir niyet kelimesi geçen VE kabul metnine sahip elementi
 * arar (herhangi bir etiket türü). Strateji 1 bir şey bulamadığında ÇAĞRILIR. */
async function tryDirectElementDismiss(page: Page): Promise<void> {
  const directSelector = DIRECT_ELEMENT_HINTS.map((hint) => `[class*="${hint}" i], [id*="${hint}" i]`).join(', ');
  const candidates = page.locator(directSelector).filter({ hasText: ACCEPT_TEXT_PATTERN });
  const candidateCount = await candidates.count().catch(() => 0);
  if (candidateCount === 0) return;

  for (let i = 0; i < Math.min(candidateCount, 5); i++) {
    const candidate = candidates.nth(i);
    const visible = await candidate.isVisible({ timeout: 200 }).catch(() => false);
    if (!visible) continue;

    await candidate.click({ timeout: 1500 }).catch(() => {});
    log.debug({ candidateIndex: i }, 'Onay/çerez banner otomatik kapatıldı (doğrudan element eşleşmesi, LLM çağrısı yapılmadı)');
    return;
  }
}
