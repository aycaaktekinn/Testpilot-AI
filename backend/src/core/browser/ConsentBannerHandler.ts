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
 * GÜVENLİK TASARIMI (önemli): bu fonksiyon "OK", "Kabul Et", "Tamam" gibi metne sahip HERHANGİ bir
 * butona körü körüne tıklamaz — bu, sayfadaki alakasız bir onay/uyarı diyaloğuna (örn. bir silme
 * onayı) yanlışlıkla tıklanmasına yol açabilir ki bu projenin "belirsiz elemente asla tıklama"
 * güvenlik ilkesine aykırı olur. Bunun yerine İKİ AŞAMALI bir eşleştirme yapılır:
 *   1) Önce id/class içinde açıkça "çerez/onay" ile ilişkili bir anahtar kelime geçen bir KAPSAYICI
 *      bulunur (cookie/consent/kvkk/gdpr/onetrust/çerez) — yani sadece GERÇEKTEN bir çerez/onay
 *      banner'ı olduğu belli olan elementlerle ilgilenilir.
 *   2) O kapsayıcının İÇİNDEKİ "kabul/onayla/accept/agree" anlamına gelen bir buton aranır.
 * Böylece sayfanın başka bir yerindeki alakasız bir "Tamam" butonuna asla dokunulmaz.
 *
 * Best-effort: banner yoksa neredeyse anında (birkaç ms) döner; herhangi bir hata sessizce
 * yutulur — bu yardımcı ASLA run'ı başarısız kılmamalı.
 */
const CONTAINER_HINTS = ['cookie', 'consent', 'kvkk', 'gdpr', 'onetrust', 'çerez', 'cerez'];

const ACCEPT_TEXT_PATTERN =
  /(kabul et|tümünü kabul et|hepsini kabul et|onayla|kabul ediyorum|accept all|accept cookies|^accept$|i agree|^agree$|allow all|got it)/i;

export async function dismissConsentBanners(page: Page): Promise<void> {
  try {
    const containerSelector = CONTAINER_HINTS.map((hint) => `[class*="${hint}" i], [id*="${hint}" i]`).join(', ');
    const containers = page.locator(containerSelector);
    const containerCount = await containers.count().catch(() => 0);
    if (containerCount === 0) return;

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
      log.debug({ containerIndex: i }, 'Onay/çerez banner otomatik kapatıldı (LLM çağrısı yapılmadı)');
      return;
    }
  } catch (err) {
    // Kasıtlı: bu yardımcı asla run'ı etkilememeli, sadece "varsa temizle, yoksa dokunma".
    log.debug({ err }, 'Onay banner temizleme adımı atlandı (hata oluştu, zararsız)');
  }
}
