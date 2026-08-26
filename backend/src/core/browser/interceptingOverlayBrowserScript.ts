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
  /** "Kabul et" metniyle eşleşecek RegExp kaynağı (bkz. ConsentBannerHandler ACCEPT_TEXT_PATTERN —
   * AYNI desen buradan tekrar kullanılır, iki yerde ayrı ayrı bakım gerekmesin diye). */
  acceptTextSrc: string;
}

export interface RecoverFromInterceptResult {
  /** target'ın merkez noktasında target'tan FARKLI bir öğe mi duruyor (yani gerçekten bir şey mi engelliyor)? */
  blocked: boolean;
  /** blocked=true ise: engelleyici öğe üzerinde açık bir kapatma kontrolü bulunup tıklandı mı? */
  closed: boolean;
}

export async function recoverFromIntercept(args: RecoverFromInterceptArgs): Promise<RecoverFromInterceptResult> {
  // KRİTİK POLYFILL — bkz. browserDiscoveryScript.ts'teki AYNI NOT (satır satır kopyalanmıştır):
  // `tsx` (esbuild) dev modunda bu fonksiyonun içindeki iç içe fonksiyonları otomatik olarak
  // `__name(fn, "isim")` ile sarıyor; o yardımcının tanımı modül seviyesinde kalırken Playwright
  // bu fonksiyonu SADECE KENDİ GÖVDESİYLE tarayıcıya taşıyor — bu satır olmadan tarayıcıda
  // "ReferenceError: __name is not defined" ile sessizce başarısız olur.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__name = (globalThis as any).__name || ((fn: unknown) => fn);

  const { x, y, target, closeTextSrc, closeAriaSrc, acceptTextSrc } = args;

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const findBlocker = (): Element | null => {
    const el = document.elementFromPoint(x, y);
    if (!el || el === target || target.contains(el) || el.contains(target)) return null;
    return el;
  };

  // v3.2 — İKİ OKUMALI (debounced) engelleyici tespiti: canlı gözlemde (hepsiburada.com, arama
  // kutusunu saran bir "initialComponent-*" hydration/geçiş kapsayıcısı) TEK bir anlık
  // elementFromPoint okuması YANILTICI çıktı — çağıran taraf (InterceptingOverlayHandler)
  // elementi viewport ortasına yeniden kaydırdıktan (`scrollIntoView`) hemen sonra yapılan
  // İLK okuma "engel yok" dedi, AMA hemen ardından denenen gerçek tıklama yine de tam
  // RETRY_TIMEOUT_CAP_MS boyunca AYNI öğe tarafından engellendi — yani engelleyici aslında
  // ORADAYDI, sadece scroll sonrası kısa bir render/geçiş penceresinde anlık olarak "kayboldu"
  // gibi göründü. Bu yüzden ilk okuma temiz çıksa bile, kısa bir bekleme sonrası İKİNCİ bir
  // doğrulama okuması yapıyoruz — o da temizse gerçekten engelsiz kabul ediyoruz; öyle değilse
  // (blocker geri geldiyse) normal engelleyici-kurtarma akışına devam ediyoruz. Toplam ek
  // maliyet sadece ~200ms (yalnızca engel yokken de harcanır) — Node tarafındaki
  // RETRY_TIMEOUT_CAP_MS bütçesinin küçük bir kısmı.
  let blocker = findBlocker();
  if (!blocker) {
    await sleep(200);
    blocker = findBlocker();
  }
  if (!blocker) {
    return { blocked: false, closed: false };
  }

  const closeText = new RegExp(closeTextSrc, 'i');
  const closeAria = new RegExp(closeAriaSrc, 'i');
  const acceptText = new RegExp(acceptTextSrc, 'i');

  // ÖNEMLİ (site bağımsız genel çözüm — bkz. sohbet notu: "hepsiburada'ya göre uyarlama, GENEL
  // sorunu çöz"): eskiden sadece <button>/<a>/[role="button"]/[aria-label] etiketlerine bakılıyordu
  // — ama gerçek sitelerde "kapat/kabul et" kontrolü sıklıkla düz bir <div>/<span>'dir (hiçbir
  // semantik/ARIA işareti olmadan, ör. hepsiburada.com'da canlı gözlemlenen
  // `<div id="hb-accept-all">Kabul Et</div>`). Bu yüzden ETİKET TÜRÜNE göre değil, "bu öğenin
  // KENDİ (torunlarını saymadan) metni kısa VE kapat/kabul kalıbıyla eşleşiyor mu" ölçütüne göre
  // aday seçiyoruz — "kısa" filtresi (aşağıdaki MAX_LABEL_LENGTH), koca bir açıklama paragrafını
  // saran bir DIŞ kapsayıcının (textContent tüm alt metni birleştirdiği için) yanlışlıkla "eşleşen"
  // ama tıklanınca hiçbir gerçek butonu TETİKLEMEYEN (click() olayı sadece tıklanan öğenin kendi
  // olay dinleyicisinde çalışır, alt elemente "sızmaz") bir dış sarmalayıcı seçilmesini engeller.
  // GÜVENLİK bu gevşetmeden ETKİLENMEZ: aday havuzu hâlâ SADECE document.elementFromPoint ile
  // GEOMETRİK olarak doğrulanmış gerçek engelleyicinin kendisi + en fazla 4 seviye atası + onların
  // torunlarıyla sınırlı — sayfanın alakasız bir yerindeki bir kontrole asla bakılmaz.
  const MAX_LABEL_LENGTH = 60;
  const ownText = (el: Element): string => {
    // El'in DOĞRUDAN metnini (alt element metinlerini saymadan) alır — kısa bir buton etiketini,
    // onu saran uzun bir paragraftan ayırt edebilmek için textContent yerine bilerek bu kullanılır.
    let text = '';
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent || '';
    }
    const trimmed = text.trim();
    // Doğrudan metni yoksa (ör. içinde sadece bir ikon + başka bir metin-taşıyan alt element varsa)
    // yine de tüm alt ağacın metnine bakılır ama SADECE kısaysa (uzun bir paragrafı yanlışlıkla
    // seçmemek için) — bu, ikon+kısa-metin şeklindeki yaygın buton yapısını da kapsar.
    if (trimmed.length > 0) return trimmed;
    const full = (el.textContent || '').trim();
    return full.length <= MAX_LABEL_LENGTH ? full : '';
  };

  const collectCandidates = (root: Element): Element[] => {
    const all = [root, ...Array.from(root.querySelectorAll('*'))];
    return all.filter((el) => {
      const text = ownText(el);
      return text.length > 0 && text.length <= MAX_LABEL_LENGTH;
    });
  };

  const tryClickMatching = (pattern: RegExp): boolean => {
    let node: Element | null = blocker;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      // En spesifik (en kısa doğrudan metinli) adaydan başla — büyük bir sarmalayıcı yerine
      // gerçek buton/etiket elementinin seçilme ihtimalini artırır.
      const candidates = collectCandidates(node).sort((a, b) => ownText(a).length - ownText(b).length);
      for (const c of candidates) {
        const text = ownText(c);
        const aria = c.getAttribute('aria-label') || '';
        if (pattern.test(text) || (pattern === closeText && closeAria.test(aria))) {
          (c as HTMLElement).click();
          return true;
        }
      }
    }
    return false;
  };

  // Engelleyici öğenin kendisinde ya da yakın atalarında (en fazla 4 seviye) açık bir "kapat"
  // kontrolü var mı? — bkz. ActionExecutor/ConsentBannerHandler ile AYNI güvenlik ilkesi: körü
  // körüne ilk görünen butona değil, sadece AÇIKÇA bir kapatma/kabul kontrolüne tıklanır. Önce
  // "kapat" denenir (daha az sonuç doğurur — sadece dialoğu geri çeker), SADECE bulunamazsa
  // "kabul et" denenir (bkz. ConsentBannerHandler dosya başı NOT — bu geometrik olarak doğrulanmış
  // engelleyicinin kendisine sınırlı olduğu için güvenlidir).
  if (tryClickMatching(closeText)) {
    return { blocked: true, closed: true };
  }
  if (tryClickMatching(acceptText)) {
    return { blocked: true, closed: true };
  }

  return { blocked: true, closed: false };
}
