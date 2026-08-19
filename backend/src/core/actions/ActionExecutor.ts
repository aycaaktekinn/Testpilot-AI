import type { Locator, Page } from 'playwright';
import type { AgentDecision, ActionResult, RunOptions } from '../../domain/types.js';
import type { ElementHandleRef } from '../dom/DomAnalyzer.js';
import { tryRecoverFromIntercept } from '../browser/InterceptingOverlayHandler.js';
import { dismissConsentBanners } from '../browser/ConsentBannerHandler.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('ActionExecutor');

/**
 * ActionExecutor, LLM'in seçtiği AgentDecision'ı Playwright üzerinde GÜVENLİ şekilde uygular.
 * "Güvenli" derken:
 *  - Sadece DomAnalyzer'ın bu adımda gerçekten keşfettiği ref'lere izin verilir (halüsinasyon koruması).
 *  - Her aksiyon kendi timeout'una sahiptir ve net, sınıflandırılmış hatalar döner.
 *  - Secret değerleri bu katmana çözülmüş (resolved) halde, sadece bu fonksiyon çağrısı süresince gelir;
 *    hiçbir yerde saklanmaz veya loglanmaz (loglama, çağıran taraftaki maskelenmiş değeri kullanır).
 */
export class ActionExecutor {
  async execute(
    page: Page,
    decision: AgentDecision,
    resolvedValue: string | undefined,
    registry: Map<string, ElementHandleRef>,
    options: RunOptions,
  ): Promise<ActionResult> {
    try {
      switch (decision.action) {
        case 'navigate': {
          if (!resolvedValue) return fail('INVALID_ACTION', 'navigate için value (URL) gerekli');
          await page.goto(resolvedValue, { timeout: options.navigationTimeoutMs, waitUntil: 'domcontentloaded' });
          return ok(`"${resolvedValue}" adresine gidildi`);
        }

        case 'go_back': {
          await page.goBack({ timeout: options.navigationTimeoutMs });
          return ok('Önceki sayfaya dönüldü');
        }

        case 'wait': {
          const ms = clampWait(resolvedValue);
          await page.waitForTimeout(ms);
          return ok(`${ms}ms beklendi`);
        }

        case 'click': {
          const locator = this.resolveLocator(decision.targetRef, registry);
          if (!locator) return fail('ELEMENT_NOT_FOUND', `Element bulunamadı: ${decision.targetRef}`);
          return this.runInteractionWithOverlayRecovery(
            page,
            locator,
            (timeoutMs, force) => locator.click({ timeout: timeoutMs, force }),
            options.defaultActionTimeoutMs,
            `Tıklandı: ${decision.targetRef}`,
          );
        }

        case 'dblclick': {
          const locator = this.resolveLocator(decision.targetRef, registry);
          if (!locator) return fail('ELEMENT_NOT_FOUND', `Element bulunamadı: ${decision.targetRef}`);
          return this.runInteractionWithOverlayRecovery(
            page,
            locator,
            (timeoutMs, force) => locator.dblclick({ timeout: timeoutMs, force }),
            options.defaultActionTimeoutMs,
            `Çift tıklandı: ${decision.targetRef}`,
          );
        }

        case 'fill': {
          const locator = this.resolveLocator(decision.targetRef, registry);
          if (!locator) return fail('ELEMENT_NOT_FOUND', `Element bulunamadı: ${decision.targetRef}`);
          if (resolvedValue === undefined) return fail('INVALID_ACTION', 'fill için value gerekli');
          await locator.fill(resolvedValue, { timeout: options.defaultActionTimeoutMs });

          // hepsiburada.com üzerinde canlı olarak gözlemlenen bir sorun: bazı arama kutuları,
          // ilk etkileşimde (focus/input) "dekoratif" bir başlangıç bileşeninden gerçek/etkin
          // bileşene GEÇİŞ YAPAR (React vb. framework'lerde component swap). .fill() teknik
          // olarak başarılı döner (DOM'a değeri yazmıştır), AMA framework bu geçişte kendi iç
          // state'ini boş olarak yeniden bağlar ve alan görünürde/gerçekte tekrar BOŞALIR —
          // hem biz hem LLM bunu fark etmeden "başarılı" sanıp devam eder, sonraki adımlarda
          // (ör. Enter'a basma) boş bir arama gönderilir ve hiçbir şey olmaz. Bu yüzden fill'den
          // sonra framework'ün olası asenkron tepkisinin oturması için kısa bir bekleme sonrası
          // değerin GERÇEKTEN kalıcı olup olmadığını doğruluyoruz; kalıcı değilse daha "gerçekçi"
          // (karakter karakter, gerçek klavye event'leriyle) bir yöntemle tekrar deniyoruz.
          const settled = await this.verifyValueStuck(locator, resolvedValue, options.defaultActionTimeoutMs);
          if (!settled) {
            await locator.fill('', { timeout: options.defaultActionTimeoutMs }).catch(() => undefined);
            await locator.pressSequentially(resolvedValue, { timeout: options.defaultActionTimeoutMs, delay: 20 });
            const settledAfterRetry = await this.verifyValueStuck(locator, resolvedValue, options.defaultActionTimeoutMs);
            if (!settledAfterRetry) {
              return fail(
                'ELEMENT_NOT_INTERACTABLE',
                `Değer yazıldı ama sayfa tarafından anında sıfırlandı (kalıcı olmadı): ${decision.targetRef}`,
              );
            }
          }

          return ok(`Dolduruldu: ${decision.targetRef}`);
        }

        case 'type': {
          const locator = this.resolveLocator(decision.targetRef, registry);
          if (!locator) return fail('ELEMENT_NOT_FOUND', `Element bulunamadı: ${decision.targetRef}`);
          if (resolvedValue === undefined) return fail('INVALID_ACTION', 'type için value gerekli');
          await locator.pressSequentially(resolvedValue, { timeout: options.defaultActionTimeoutMs, delay: 20 });

          // 'fill' için yukarıda açıklanan aynı "değer kalıcı değil" sorununa karşı aynı doğrulama;
          // 'type' zaten gerçek klavye event'leri kullandığı için burada tek bir tekrar denemesi
          // yeterli (kısa bir asenkron state-senkron gecikmesini tolere etmek için).
          const settled = await this.verifyValueStuck(locator, resolvedValue, options.defaultActionTimeoutMs);
          if (!settled) {
            await locator.fill('', { timeout: options.defaultActionTimeoutMs }).catch(() => undefined);
            await locator.pressSequentially(resolvedValue, { timeout: options.defaultActionTimeoutMs, delay: 20 });
            const settledAfterRetry = await this.verifyValueStuck(locator, resolvedValue, options.defaultActionTimeoutMs);
            if (!settledAfterRetry) {
              return fail(
                'ELEMENT_NOT_INTERACTABLE',
                `Değer yazıldı ama sayfa tarafından anında sıfırlandı (kalıcı olmadı): ${decision.targetRef}`,
              );
            }
          }

          return ok(`Yazıldı: ${decision.targetRef}`);
        }

        case 'press_key': {
          if (!resolvedValue) return fail('INVALID_ACTION', 'press_key için value (tuş adı) gerekli');
          if (decision.targetRef) {
            const locator = this.resolveLocator(decision.targetRef, registry);
            if (!locator) return fail('ELEMENT_NOT_FOUND', `Element bulunamadı: ${decision.targetRef}`);
            await locator.press(resolvedValue, { timeout: options.defaultActionTimeoutMs });
          } else {
            await page.keyboard.press(resolvedValue);
          }
          return ok(`Tuşa basıldı: ${resolvedValue}`);
        }

        case 'select_option': {
          const locator = this.resolveLocator(decision.targetRef, registry);
          if (!locator) return fail('ELEMENT_NOT_FOUND', `Element bulunamadı: ${decision.targetRef}`);
          if (resolvedValue === undefined) return fail('INVALID_ACTION', 'select_option için value gerekli');
          await locator.selectOption({ label: resolvedValue }, { timeout: options.defaultActionTimeoutMs }).catch(async () => {
            await locator.selectOption(resolvedValue, { timeout: options.defaultActionTimeoutMs });
          });
          return ok(`Seçildi: ${decision.targetRef} -> ${resolvedValue}`);
        }

        case 'check': {
          const locator = this.resolveLocator(decision.targetRef, registry);
          if (!locator) return fail('ELEMENT_NOT_FOUND', `Element bulunamadı: ${decision.targetRef}`);
          return this.runInteractionWithOverlayRecovery(
            page,
            locator,
            (timeoutMs, force) => locator.check({ timeout: timeoutMs, force }),
            options.defaultActionTimeoutMs,
            `İşaretlendi: ${decision.targetRef}`,
          );
        }

        case 'uncheck': {
          const locator = this.resolveLocator(decision.targetRef, registry);
          if (!locator) return fail('ELEMENT_NOT_FOUND', `Element bulunamadı: ${decision.targetRef}`);
          return this.runInteractionWithOverlayRecovery(
            page,
            locator,
            (timeoutMs, force) => locator.uncheck({ timeout: timeoutMs, force }),
            options.defaultActionTimeoutMs,
            `İşaret kaldırıldı: ${decision.targetRef}`,
          );
        }

        case 'hover': {
          const locator = this.resolveLocator(decision.targetRef, registry);
          if (!locator) return fail('ELEMENT_NOT_FOUND', `Element bulunamadı: ${decision.targetRef}`);
          return this.runInteractionWithOverlayRecovery(
            page,
            locator,
            (timeoutMs, force) => locator.hover({ timeout: timeoutMs, force }),
            options.defaultActionTimeoutMs,
            `Üzerine gelindi: ${decision.targetRef}`,
          );
        }

        case 'scroll_into_view': {
          const locator = this.resolveLocator(decision.targetRef, registry);
          if (!locator) return fail('ELEMENT_NOT_FOUND', `Element bulunamadı: ${decision.targetRef}`);
          await locator.scrollIntoViewIfNeeded({ timeout: options.defaultActionTimeoutMs });
          return ok(`Görünüme kaydırıldı: ${decision.targetRef}`);
        }

        case 'assert_visible': {
          const locator = this.resolveLocator(decision.targetRef, registry);
          if (!locator) return fail('ELEMENT_NOT_FOUND', `Element bulunamadı: ${decision.targetRef}`);
          const visible = await locator.isVisible();
          if (!visible) return fail('ASSERTION_FAILED', `Beklenen element görünür değil: ${decision.targetRef}`);
          return ok(`Doğrulandı (görünür): ${decision.targetRef}`);
        }

        case 'assert_text': {
          if (resolvedValue === undefined) return fail('INVALID_ACTION', 'assert_text için value gerekli');
          const bodyText = await page.locator('body').innerText().catch(() => '');
          if (!bodyText.includes(resolvedValue)) {
            return fail('ASSERTION_FAILED', `Sayfada beklenen metin bulunamadı: "${resolvedValue}"`);
          }
          return ok(`Doğrulandı (metin mevcut): "${resolvedValue}"`);
        }

        case 'assert_url': {
          if (resolvedValue === undefined) return fail('INVALID_ACTION', 'assert_url için value gerekli');
          const currentUrl = page.url();
          if (!currentUrl.includes(resolvedValue)) {
            return fail('ASSERTION_FAILED', `URL beklenen değeri içermiyor. Mevcut: ${currentUrl}, beklenen parça: ${resolvedValue}`);
          }
          return ok(`Doğrulandı (URL): ${currentUrl}`);
        }

        case 'finish_success':
        case 'finish_failure':
        case 'ask_clarification':
          // Bunlar AgentLoop tarafından ele alınır, ActionExecutor'a hiç gelmemesi beklenir.
          return ok('Kontrol AgentLoop tarafından ele alındı');

        default:
          return fail('INVALID_ACTION', `Bilinmeyen aksiyon: ${decision.action as string}`);
      }
    } catch (err) {
      return this.classifyError(err);
    }
  }

  /**
   * fill/type sonrası, değerin sayfa tarafından asenkron olarak (ör. bir React component
   * swap'i veya redux/state senkronizasyonu sonucu) geri sıfırlanmadığını doğrular. Bazı
   * SPA'larda ilk etkileşim bir bileşen geçişini tetikler ve bu geçiş yazılan değeri kaybeder
   * — bu, .fill()/pressSequentially() BAŞARILI döndükten SONRA, kısa bir gecikmeyle gerçekleşir,
   * bu yüzden burada kısa bir "yerleşme" beklemesi (settle) sonrası tekrar okuyoruz.
   * Standart <input>/<textarea>/<select> DIŞI (ör. contenteditable) elementlerde inputValue()
   * hata fırlatır; bu durumda doğrulama yapılamaz sayılır ve orijinal davranışa (sessizce OK)
   * geri dönülür — burada FALSE değil TRUE döndürmek doğru: bu elementler için zaten hiçbir
   * zaman doğrulama yapamayacağız, bunu "başarısız" gibi yorumlamak yanlış negatiflere yol açar.
   */
  private async verifyValueStuck(locator: Locator, expectedValue: string, timeoutMs: number): Promise<boolean> {
    await locator.page().waitForTimeout(300);
    try {
      const actual = await locator.inputValue({ timeout: Math.min(2000, timeoutMs) });
      return actual === expectedValue;
    } catch {
      return true;
    }
  }

  /**
   * click/dblclick/check/uncheck/hover ORTAK sarmalayıcısı: Playwright'ın actionability kontrolü
   * ("element gerçekten pointer event alabiliyor mu") bir TIMEOUT/ELEMENT_NOT_INTERACTABLE ile
   * başarısız olursa, hepsiburada.com üzerinde canlı olarak gözlemlenen sınıftaki sorunlara karşı
   * (bkz. InterceptingOverlayHandler dosya başı açıklaması) TEK SEFERLİK bir kurtarma + tekrar
   * deneme yapar. Kurtarma denemesi bir şey YAPAMADIYSA (tryRecoverFromIntercept false döndüyse),
   * hiç tekrar denemeden orijinal hatayı döndürür — bu, LoopGuard'ın gereksiz yere atlatılmasını
   * (ör. gerçekten var olmayan bir elemente sonsuza kadar "kurtarma" denemesi) engeller: en fazla
   * BİR ekstra deneme yapılır, LLM'e hiç danışılmaz (ekstra bir LLM çağrısı YOKTUR).
   *
   * ÖNEMLİ (zaman aşımı bütçesi): RETRY denemesi kasıtlı olarak orijinal `timeoutMs`'in TAMAMINI
   * DEĞİL, çok daha kısa bir üst sınırı (RETRY_TIMEOUT_CAP_MS) kullanır. Sebep: bu metodun tamamı,
   * AgentLoop.withTimeout()'un uyguladığı adım-başı sert üst sınırın (options.stepTimeoutMs,
   * varsayılan 15000ms) İÇİNDE bitmek zorunda — o üst sınır aşılırsa AgentLoop bunu bir adım
   * hatası olarak DEĞİL, TÜM RUN'ı hiç adım loglanmadan 'error' durumuna düşüren bir hata olarak
   * ele alır (bkz. AgentLoop.ts). Eğer hem orijinal hem de retry denemesi tam options.defaultAction
   * TimeoutMs (varsayılan 10000ms) kullansaydı, en kötü senaryo (10000 + ~300-500ms kurtarma
   * overhead'i + 10000 retry ≈ 20300-20500ms) 15000ms'lik dış limiti rahatlıkla aşardı — canlıda
   * tam olarak gözlemlenen "Toplam adım: 0, ERROR" regresyonu buydu. RETRY_TIMEOUT_CAP_MS ile
   * en kötü senaryo ~10000 + 500 + 3000 ≈ 13500ms'e iniyor, dış limitin altında güvenli bir marj
   * bırakıyor.
   *
   * ÇEREZ/ONAY BANNER'I YARIŞ DURUMU DÜZELTMESİ (yeni): AgentLoop, HER adımın BAŞINDA (DOM taraması
   * yapılmadan önce) dismissConsentBanners() çağırır — ama snapshot alınıp LLM kararını verdikten
   * SONRA, biz buraya (asıl click/vb. çağrısına) gelene kadar geçen sürede banner YENİ belirmiş
   * olabilir (hepsiburada.com'da canlı olarak gözlemlendi: "Element şu anda etkileşime uygun değil"
   * hatasıyla adım 1'de başarısız olup LLM'in hemen finish_failure ile run'ı bitirdiği durum).
   * tryRecoverFromIntercept() SADECE "×/kapat/close/dismiss" gibi AÇIK bir KAPATMA kontrolü arar —
   * "Kabul Et"/"Onayla" gibi bir ONAY metnine kasıtlı olarak dokunmaz (bkz. o dosyanın güvenlik
   * notu). Bu yüzden burada, generic kurtarmadan ÖNCE, ayrıca ve özel olarak dismissConsentBanners()
   * çağrılıyor — bu fonksiyon SADECE id/class'ında açıkça cookie/consent/kvkk/gdpr geçen bir
   * KAPSAYICI içindeki "kabul et" metnine sahip butona tıklar (bkz. ConsentBannerHandler dosya başı
   * güvenlik notu), yani alakasız bir onay diyaloğuna asla dokunmaz. Banner yoksa neredeyse anında
   * (birkaç ms) döner, normal akışı yavaşlatmaz.
   *
   * KALICI (kapatılamayan) ENGELLEYİCİ DÜZELTMESİ (yeni, hepsiburada.com "Sepete Ekle" regresyon
   * koruması): bazı engelleyiciler bir modal/popup değil, sayfanın normal bir parçasıdır (ör. sticky
   * bir "Sepete Ekle" alt bar'ı) — kapatılacak bir kontrolleri YOKTUR. tryRecoverFromIntercept() bu
   * durumu `persistentBlocker: true` ile işaretler (bkz. o dosyanın açıklaması); bu durumda retry,
   * Playwright'ın actionability kontrolünü atlayan `force: true` ile denenir — FARKLI bir elemente
   * DEĞİL, LLM'in zaten seçtiği AYNI elemente, sadece "pointer olayı gerçekten oraya mı ulaşıyor"
   * kontrolü atlanarak tıklanır. Canlıda gözlemlenen zincir: aynı buton farklı ref adlarıyla (DOM her
   * adımda yeniden taranıp ref'ler yeniden atandığı için) 3 kez TIMEOUT ile başarısız olup sonunda
   * LoopGuard'ın "loop_detected" ile run'ı bitirmesiydi.
   */
  private static readonly RETRY_TIMEOUT_CAP_MS = 3000;

  private async runInteractionWithOverlayRecovery(
    page: Page,
    locator: Locator,
    attempt: (timeoutMs: number, force?: boolean) => Promise<void>,
    timeoutMs: number,
    successMessage: string,
  ): Promise<ActionResult> {
    try {
      await attempt(timeoutMs);
      return ok(successMessage);
    } catch (err) {
      const classified = this.classifyError(err);
      if (classified.errorCode !== 'TIMEOUT' && classified.errorCode !== 'ELEMENT_NOT_INTERACTABLE') {
        return classified;
      }

      await dismissConsentBanners(page);
      const recovery = await tryRecoverFromIntercept(page, locator);
      if (!recovery.attempted) return classified;

      try {
        const retryTimeoutMs = Math.min(timeoutMs, ActionExecutor.RETRY_TIMEOUT_CAP_MS);
        // `|| undefined`: force'u SADECE gerçekten gerekliyken (persistentBlocker) açıkça true
        // gönderiyoruz; aksi halde undefined bırakıyoruz ki Playwright'ın kendi varsayılanıyla
        // (force:false) davransın — "force:false" açıkça geçmekle "hiç geçmemek" işlevsel olarak
        // aynı olsa da, ikincisi test/log çıktısında daha net (gereksiz bir "force" alanı yok).
        await attempt(retryTimeoutMs, recovery.persistentBlocker || undefined);
        log.debug(
          { forced: recovery.persistentBlocker },
          'Engelleyici öğe kurtarma denemesi sonrası aksiyon başarılı oldu',
        );
        return ok(successMessage);
      } catch (retryErr) {
        return this.classifyError(retryErr);
      }
    }
  }

  private resolveLocator(targetRef: string | undefined, registry: Map<string, ElementHandleRef>) {
    if (!targetRef) return null;
    const entry = registry.get(targetRef);
    if (!entry) return null;
    return entry.frame.locator(entry.selector).first();
  }

  private classifyError(err: unknown): ActionResult {
    const message = err instanceof Error ? err.message : String(err);
    log.debug({ err }, 'Aksiyon çalıştırılırken hata');

    if (/Timeout .* exceeded/i.test(message)) {
      return fail('TIMEOUT', 'İşlem zaman aşımına uğradı (element etkileşilebilir olmayabilir)');
    }
    if (/not visible|not attached|not enabled|intercepts pointer events/i.test(message)) {
      return fail('ELEMENT_NOT_INTERACTABLE', 'Element şu anda etkileşime uygun değil');
    }
    if (/net::ERR|navigation/i.test(message)) {
      return fail('NAVIGATION_ERROR', 'Sayfa yüklenirken/gezinirken hata oluştu');
    }
    return fail('UNKNOWN', 'Beklenmeyen bir hata oluştu');
  }
}

function ok(message: string): ActionResult {
  return { ok: true, message };
}

function fail(errorCode: ActionResult['errorCode'], message: string): ActionResult {
  return { ok: false, message, errorCode };
}

function clampWait(rawValue: string | undefined): number {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1000;
  return Math.min(parsed, 8000);
}
