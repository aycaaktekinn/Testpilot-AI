/**
 * NOT (önemli): Bu dosyadaki `recoverFromIntercept` fonksiyonu Node.js'te DEĞİL, page.evaluate()
 * aracılığıyla TARAYICI (browser) bağlamında çalıştırılır — birebir aynı yaklaşım için bkz.
 * browserDiscoveryScript.ts dosya başındaki NOT (Playwright bu fonksiyonu `toString()` ile
 * serileştirip sayfa içinde yeniden oluşturur; fonksiyon Node.js kapsamındaki hiçbir değişkene
 * erişemez, sadece kendisine geçilen `args` üzerinden veri alır — bu yüzden `target` bir
 * ElementHandle olarak geçilir, Playwright bunu tarayıcı tarafında otomatik olarak gerçek
 * elemente çözer).
 *
 * Projenin geri kalanı Node ortamında çalıştığı için tsconfig.json bilerek "DOM" lib'ini
 * içermiyor. Bu dosya `document`/`Element`/`HTMLElement` gibi tarayıcıya özgü tipler
 * kullandığından, dosya seviyesinde tip denetimini devre dışı bırakıyoruz.
 */
// @ts-nocheck

export interface RecoverFromInterceptArgs {
  /** Hedef elementin (kaydırma sonrası) viewport'taki merkez noktası. */
  x: number;
  y: number;
  /** Asıl tıklanmak istenen element (LLM'in seçtiği ref). */
  target: Element;
  /** "Kapat" metniyle eşleşecek RegExp kaynağı (bkz. InterceptingOverlayHandler CLOSE_TEXT_PATTERN). */
  closeTextSrc: string;
  /** "Kapat" aria-label'ıyla eşleşecek RegExp kaynağı (bkz. InterceptingOverlayHandler CLOSE_ARIA_PATTERN). */
  closeAriaSrc: string;
}

export interface RecoverFromInterceptResult {
  /** target'ın merkez noktasında target'tan FARKLI bir öğe mi duruyor (yani gerçekten bir şey mi engelliyor)? */
  blocked: boolean;
  /** blocked=true ise: engelleyici öğe üzerinde açık bir kapatma kontrolü bulunup tıklandı mı? */
  closed: boolean;
}

export function recoverFromIntercept(args: RecoverFromInterceptArgs): RecoverFromInterceptResult {
  // KRİTİK POLYFILL — bkz. browserDiscoveryScript.ts'teki AYNI NOT (satır satır kopyalanmıştır):
  // `tsx` (esbuild) dev modunda bu fonksiyonun içindeki iç içe fonksiyonları otomatik olarak
  // `__name(fn, "isim")` ile sarıyor; o yardımcının tanımı modül seviyesinde kalırken Playwright
  // bu fonksiyonu SADECE KENDİ GÖVDESİYLE tarayıcıya taşıyor — bu satır olmadan tarayıcıda
  // "ReferenceError: __name is not defined" ile sessizce başarısız olur.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__name = (globalThis as any).__name || ((fn: unknown) => fn);

  const { x, y, target, closeTextSrc, closeAriaSrc } = args;

  const blocker = document.elementFromPoint(x, y);
  if (!blocker || blocker === target || target.contains(blocker) || blocker.contains(target)) {
    return { blocked: false, closed: false };
  }

  const closeText = new RegExp(closeTextSrc, 'i');
  const closeAria = new RegExp(closeAriaSrc, 'i');

  // Engelleyici öğenin kendisinde ya da yakın atalarında (en fazla 4 seviye) açık bir "kapat"
  // kontrolü var mı? — bkz. ActionExecutor/ConsentBannerHandler ile AYNI güvenlik ilkesi: körü
  // körüne ilk görünen butona değil, sadece AÇIKÇA bir kapatma kontrolüne tıklanır.
  let node: Element | null = blocker;
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    const candidates = node.querySelectorAll('button, a, [role="button"], [aria-label]');
    for (const c of Array.from(candidates)) {
      const text = (c.textContent || '').trim();
      const aria = c.getAttribute('aria-label') || '';
      if (closeText.test(text) || closeAria.test(aria)) {
        (c as HTMLElement).click();
        return { blocked: true, closed: true };
      }
    }
  }

  return { blocked: true, closed: false };
}
