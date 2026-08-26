import type { Locator, Page } from 'playwright';
import { recoverFromIntercept } from './interceptingOverlayBrowserScript.js';
import { ACCEPT_TEXT_PATTERN } from './ConsentBannerHandler.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('InterceptingOverlayHandler');

/**
 * ConsentBannerHandler yalnızca çerez/onay banner'larına özeldir (bkz. o dosyanın başındaki not).
 * Ancak gerçek sitelerde bir tıklamayı engelleyen tek şey çerez banner'ı değildir: sticky/fixed bir
 * üst menü, "sepete eklendi" bildirimi, lazy-load reklam, kampanya bar'ı gibi PEK ÇOK farklı öğe de
 * bir elementin ÜZERİNE gelip Playwright'ın actionability kontrolünü ("bu element gerçekten pointer
 * event alabiliyor mu") başarısız kılabilir. Bu durumda click TIMEOUT ile başarısız olur, ANCAK
 * scroll_into_view (çok daha gevşek bir kontrole sahip — elementin var/bağlı olması yeterli) BAŞARILI
 * döner — hepsiburada.com üzerinde canlı olarak gözlemlenen tam olarak bu asimetri (bkz.
 * ActionExecutor.runInteractionWithOverlayRecovery).
 *
 * Bu modül, click/dblclick/check/uncheck/hover bir TIMEOUT/ELEMENT_NOT_INTERACTABLE hatasıyla
 * başarısız olduğunda TEK SEFERLİK bir kurtarma denemesi yapar:
 *   1) Elementi, olası bir sticky header/footer'ın altında/üstünde kalmayacak şekilde viewport'un
 *      ORTASINA yeniden kaydırır (native scrollIntoViewIfNeeded genelde elementi viewport kenarına
 *      hizalar — bu da tam olarak sticky bir header'ın kapladığı bölgedir).
 *   2) Elementin merkez noktasında GERÇEKTEN hangi öğenin durduğunu (document.elementFromPoint,
 *      bkz. interceptingOverlayBrowserScript.ts) kontrol eder; bu öğe hedef elementin kendisi
 *      DEĞİLSE, bir şey onu engelliyor demektir.
 *   3) Engelleyici öğenin kendisinde veya yakın üst kapsayıcısında "kapat/dismiss" anlamına gelen
 *      AÇIK bir kontrol varsa (× sembolü, aria-label="close" vb.) TIKLANIR; bulunamazsa AYNI yerde
 *      "kabul et/accept" anlamına gelen bir kontrol denenir (bkz. ConsentBannerHandler
 *      ACCEPT_TEXT_PATTERN — burada güvenli çünkü arama GEOMETRİK olarak doğrulanmış gerçek
 *      engelleyiciyle sınırlı); o da yoksa Escape tuşuna basılır (pek çok modal/popup bunu dinler).
 *      Aday seçimi ETİKET TÜRÜNE (button/a/vb.) değil, "kendi metni kısa ve kalıpla eşleşiyor mu"
 *      ölçütüne göre yapılır (bkz. interceptingOverlayBrowserScript.ts dosya başı NOT) — böylece
 *      hiçbir semantik işareti olmayan düz bir `<div>`/`<span>` tabanlı kontrol de yakalanır. Bu,
 *      ConsentBannerHandler'daki GÜVENLİK İLKESİYLE AYNIDIR: körü körüne "ilk görünen buton"a
 *      değil, sadece GEOMETRİK olarak doğrulanmış gerçek engelleyicinin İÇİNDEKİ/YAKININDAKİ bir
 *      kontrole tıklanır — sayfanın alakasız bir yerindeki bir butona asla dokunulmaz.
 *
 * Bu fonksiyon orijinal aksiyonu KENDİSİ tekrar denemez — sadece "engel olabilecek bir şeyi temizlemeyi
 * dene" işini yapar; asıl retry çağıran tarafta (ActionExecutor) olur. Best-effort: hiçbir zaman
 * fırlatmaz, sadece "denemeye değer mi" bilgisini (bkz. OverlayRecoveryResult) döner.
 *
 * KALICI (kapatılamayan) ENGELLEYİCİLER (hepsiburada.com "Sepete Ekle" regresyon koruması): bazı
 * engelleyiciler bir modal/popup DEĞİL, sayfanın normal bir parçasıdır (ör. sticky bir "Sepete Ekle"
 * alt bar'ı, kampanya şeridi) — bunların kapatılacak bir "×" kontrolü YOKTUR ve olması da beklenmez.
 * Böyle bir durumda (blocked=true, closed=false) elimizde açık bir kapatma seçeneği olmadığından
 * Escape denenir ama işe yaramaz ve retry AYNI hatayla tekrar başarısız olur — canlıda gözlemlenen
 * "3 farklı ref denendi, hepsi TIMEOUT, sonra loop_detected" zinciri tam olarak budur. Bu fonksiyon
 * artık bu durumu `persistentBlocker: true` ile ayrıca işaretliyor; ActionExecutor bunu retry
 * denemesinde Playwright'ın "pointer olayı GERÇEKTEN o elemente mi ulaşıyor" actionability
 * kontrolünü atlayan `force: true` ile denemek için kullanıyor. Bu GÜVENLİDİR çünkü FARKLI bir
 * elemente tıklamıyoruz — document.elementFromPoint kontrolüyle zaten hedefin (LLM'in seçtiği
 * elementin) kendisi olduğunu/geçerli bir konumda bulunduğunu doğruladık, sadece üzerine gelen
 * dekoratif/sticky bir öğe yüzünden Playwright'ın kendi güvenlik kontrolü engelleniyor.
 */
const CLOSE_TEXT_PATTERN = '^(×|x|✕|✖|kapat|close|dismiss|anladım|tamam|got it|no thanks)$';
const CLOSE_ARIA_PATTERN = '(close|kapat|dismiss)';

export interface OverlayRecoveryResult {
  /** En az bir kurtarma adımı denendi mi — false ise retry'a hiç değmez (orijinal hata döndürülmeli). */
  attempted: boolean;
  /**
   * true ise: element gerçekten bir şey tarafından engelleniyor AMA açıkça kapatılabilir bir kontrol
   * bulunamadı (ör. sticky bar). ActionExecutor bunu retry'da force:true ile denemek için kullanır.
   */
  persistentBlocker: boolean;
}

const NOT_ATTEMPTED: OverlayRecoveryResult = { attempted: false, persistentBlocker: false };

export async function tryRecoverFromIntercept(page: Page, locator: Locator): Promise<OverlayRecoveryResult> {
  try {
    const box = await locator.boundingBox().catch(() => null);
    if (!box) return NOT_ATTEMPTED; // element zaten görünür/bağlı değil — bu fonksiyonun ele aldığı durum bu değil.

    // 1) Sticky header/footer altında/üstünde kalma ihtimaline karşı elementi viewport ORTASINA al.
    await locator.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => undefined);
    await page.waitForTimeout(150);

    const freshBox = await locator.boundingBox().catch(() => null);
    if (!freshBox) return NOT_ATTEMPTED;
    const centerX = freshBox.x + freshBox.width / 2;
    const centerY = freshBox.y + freshBox.height / 2;

    const targetElementHandle = await locator.elementHandle().catch(() => null);
    if (!targetElementHandle) return { attempted: true, persistentBlocker: false }; // en azından yeniden ortalama denendi, tekrar denemeye değer.

    let result: { blocked: boolean; closed: boolean };
    try {
      result = await page.evaluate(recoverFromIntercept, {
        x: centerX,
        y: centerY,
        target: targetElementHandle,
        closeTextSrc: CLOSE_TEXT_PATTERN,
        closeAriaSrc: CLOSE_ARIA_PATTERN,
        acceptTextSrc: ACCEPT_TEXT_PATTERN.source,
      });
    } finally {
      await targetElementHandle.dispose().catch(() => undefined);
    }

    if (!result.blocked) {
      return { attempted: true, persistentBlocker: false }; // yeniden ortalama muhtemelen yeterliydi, ekstra bir şey yapmaya gerek yok.
    }

    if (result.closed) {
      log.debug('Engelleyici öğe üzerinde açık bir kapatma kontrolü bulunup tıklandı');
      await page.waitForTimeout(150);
      return { attempted: true, persistentBlocker: false };
    }

    // Açık bir kapatma kontrolü yoksa son çare: Escape (pek çok modal/popup bunu dinler); işe
    // yaramazsa retry'ın force:true ile denenebilmesi için persistentBlocker=true işaretleniyor.
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(150);
    log.debug('Açık bir kapatma kontrolü bulunamadı; Escape tuşu denendi, retry force:true ile denenecek');
    return { attempted: true, persistentBlocker: true };
  } catch (err) {
    // Kasıtlı: bu yardımcı asla orijinal hatanın yerine geçmemeli — sadece "denemeye değer mi" bilgisi verir.
    log.debug({ err }, 'Engelleyici öğe kurtarma denemesi başarısız (zararsız, orijinal hata döndürülecek)');
    return NOT_ATTEMPTED;
  }
}
