/**
 * NOT (önemli): Bu dosyadaki `runDiscovery` fonksiyonu Node.js'te DEĞİL, page.evaluate() /
 * frame.evaluate() aracılığıyla TARAYICI (browser) bağlamında çalıştırılır. Playwright bu
 * fonksiyonu `toString()` ile serileştirip sayfa içinde yeniden oluşturur; bu yüzden fonksiyon
 * Node.js kapsamındaki hiçbir değişkene erişemez, sadece kendisine geçilen `args` üzerinden veri alır.
 *
 * Projenin geri kalanı Node ortamında çalıştığı için tsconfig.json bilerek "DOM" lib'ini
 * içermiyor (Node globalleriyle çakışmaması için). Bu dosya `document`/`window`/`Element` gibi
 * tarayıcıya özgü tipler kullandığından, dosya seviyesinde tip denetimini devre dışı bırakıyoruz;
 * fonksiyon yine de normal şekilde JS'e derlenir (sadece bu dosyadaki tip hataları göz ardı edilir).
 */
// @ts-nocheck

export interface DiscoveryArgs {
  /** Bu frame içindeki referans numaralandırmasının başlayacağı değer (global benzersizlik için). */
  startIndex: number;
  /** Bu frame'den en fazla kaç element döndürüleceği. */
  maxElements: number;
}

export interface RawDiscoveredElement {
  ref: string;
  tag: string;
  role: string | null;
  accessibleName: string | null;
  text: string | null;
  attributes: Record<string, string>;
  visible: boolean;
  enabled: boolean;
  inViewport: boolean;
  currentValue?: string;
  /**
   * SADECE <select> elementleri için: TÜM <option>'ların görünen metinleri (makul bir üst sınırla,
   * bkz. bu alanın doldurulduğu yerdeki NOT). select_option aksiyonu için LLM'in geçerli "value"
   * olarak hangi metni yazabileceğini bilmesi bunu gerektirir — ActionExecutor.select_option önce
   * bu GÖRÜNEN metinle eşleştirmeyi dener (`.selectOption({ label: resolvedValue })`).
   */
  options?: string[];
}

export interface DiscoveryResult {
  elements: RawDiscoveredElement[];
  totalCandidates: number;
  nextIndex: number;
  /** Görünür ama TIKLANABİLİR OLMAYAN hata/uyarı/bildirim metinleri. Bkz. PageSnapshot.alerts. */
  alerts: string[];
}

export function runDiscovery(args: DiscoveryArgs): DiscoveryResult {
  // KRİTİK POLYFILL — BU SATIRI SİLMEYİN/TAŞIMAYIN, İLK SATIR OLMALI:
  // Geliştirme ortamında bu proje `tsx` (esbuild tabanlı) ile çalıştırılıyor ve tsx, TÜM
  // dosyaları `keepNames: true` + `minifyWhitespace: true` ile derliyor. Bu kombinasyon, esbuild'in
  // bu fonksiyonun İÇİNDEKİ her iç içe fonksiyonu (collect, isVisible, vb.) otomatik olarak bir
  // `__name(fn, "isim")` yardımcı çağrısına sarmasına yol açıyor. O yardımcının TANIMI modül
  // seviyesinde kalıyor — ama Playwright'ın page.evaluate()/frame.evaluate() çağrısı bu fonksiyonu
  // `Function.prototype.toString()` ile SADECE KENDİ GÖVDESİYLE serileştirip tarayıcıda yeniden
  // oluşturuyor (çevresindeki modülü DEĞİL). Sonuç: tarayıcıda "ReferenceError: __name is not
  // defined" hatasıyla bu fonksiyon (ve dolayısıyla TÜM element keşfi) sessizce başarısız oluyordu
  // — bu satır olmadan bu dosya production build'de (tsc ile, esbuild olmadan) SORUNSUZ çalışır,
  // ama `npm run dev` (tsx watch) ile HER ZAMAN patlar. Zararsız bir no-op polyfill ile çözüyoruz
  // (fonksiyon isimlerini burada korumanın hiçbir işlevsel önemi yok). ÖNEMLİ: burada `__name`'e
  // bare identifier olarak DEĞİL, `globalThis.__name` şeklinde erişiyoruz — aksi halde esbuild,
  // kendi enjekte ettiği yardımcıyı adı çakışmasın diye "__name2" gibi başka bir isme çevirip bu
  // polyfill'i etkisiz bırakabiliyor.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__name = (globalThis as any).__name || ((fn: unknown) => fn);

  const { startIndex, maxElements } = args;

  // Önceki adımdan kalan işaretleri temizle.
  document.querySelectorAll('[data-ai-ref]').forEach((el) => el.removeAttribute('data-ai-ref'));

  const seen = new Set<Element>();
  const candidates: Element[] = [];

  // ÖNEMLİ: bu sabit BİLEREK runDiscovery'nin İÇİNDE tanımlanıyor (modül seviyesinde DEĞİL).
  // Playwright'ın page.evaluate()/frame.evaluate() çağrısı bu fonksiyonu sadece KENDİ GÖVDESİYLE
  // (Function.prototype.toString()) serileştirip tarayıcıda çalıştırıyor — modül seviyesindeki
  // hiçbir değişkene erişemiyor. Bu sabit dışarıda tanımlıysa aşağıdaki `collect()` içindeki
  // referansı tarayıcıda "ReferenceError: INTERACTIVE_SELECTOR is not defined" ile patlar (ve
  // element keşfi sessizce hep boş sonuç döner — tam olarak yaşanan sorun buydu).
  const INTERACTIVE_SELECTOR = [
    // ÖNCEDEN 'a[href]' idi (sadece <a> etiketi). hepsiburada.com'da canlı olarak doğrulandı:
    // "Giriş Yap" hesap menüsü tetikleyicisi <a> DEĞİL, <span href="javascript:;" ...> şeklinde
    // eski (jQuery döneminden kalma) bir "sahte link" deseni — href gerçek bir navigasyon
    // yapmıyor, sadece "bu tıklanabilir" sinyali olarak duruyor (gerçek davranış JS click
    // handler'ından geliyor). `href` ATTRIBUTE'U (span dahil HANGİ ETİKETTE olursa olsun) bu
    // yüzden `[href]` olarak genelleştirildi — bir geliştirici href'i başka bir amaçla, tıklanabilir
    // olmayan bir elemente ASLA eklemez, dolayısıyla bu güvenli/genel bir sinyal.
    //
    // NOT: computed `cursor: pointer` stiline dayanan ek keşif katmanımız (aşağıda, collect()
    // içinde) BU elementi YAKALAYAMADI çünkü hepsiburada'da cursor:pointer sadece `:hover`
    // durumunda uygulanıyor (`.sf-OldMyAccount:hover { cursor: pointer }`) — otomatik tarama
    // sırasında fare elementin üzerinde OLMADIĞI için computed cursor 'pointer' değil 'default'
    // dönüyordu. Bu, "hover-bağımlı cursor" tuzağına düşmeyen, statik bir attribute kontrolü
    // olduğu için daha güvenilir.
    '[href]',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    'summary',
    'label',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="switch"]',
    '[role="combobox"]',
    '[role="option"]',
    '[role="textbox"]',
    '[role="searchbox"]',
    '[role="slider"]',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[tabindex]',
    '[onclick]',
  ].join(',');

  function collect(root: Document | ShadowRoot) {
    const found = root.querySelectorAll(INTERACTIVE_SELECTOR);
    found.forEach((el) => {
      if (!seen.has(el)) {
        seen.add(el);
        candidates.push(el);
      }
    });
    // Açık (open) shadow root'lara da in: sadece open shadow root JS'ten erişilebilir,
    // closed olanlar zaten hiçbir otomasyon aracınca görülemez.
    const all = root.querySelectorAll('*');
    all.forEach((el) => {
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) collect(shadow);

      // EK KEŞİF (hepsiburada.com üzerinde canlı olarak doğrulandı — bkz. AgentLoop/DomAnalyzer
      // teşhis logları): modern SPA'larda (React/Vue) birçok gerçekten tıklanabilir element
      // (örn. "Hesabım/Giriş Yap" hesap menüsü tetikleyicisi) semantik bir <button>/<a href>
      // DEĞİLDİR — sadece addEventListener('click', ...) ile JS'ten bağlanmış, çıplak bir
      // <div>/<span>'dir. Bunlarda role/tabindex/onclick ATTRIBUTE'U da genelde YOKTUR (React'in
      // sentetik onClick'i hiçbir zaman bir HTML onclick attribute'u YAZMAZ), bu yüzden yukarıdaki
      // INTERACTIVE_SELECTOR bunları YAKALAYAMAZ ve element keşfi sessizce o elementi atlar — LLM
      // de "sayfada böyle bir element yok" sonucuna varır (bu tam olarak yaşanan sorundu).
      //
      // Güvenilir ikincil sinyal: TARAYICININ HESAPLADIĞI "cursor: pointer" stili — bir geliştirici
      // bunu neredeyse HER ZAMAN sadece gerçekten tıklanabilir elementlere uygular. `cursor` CSS'te
      // KALITSAL (inherited) bir özellik olduğundan, bir kapsayıcıya cursor:pointer verildiğinde
      // İÇİNDEKİ tüm metin/ikon span'ları da aynı değeri hesaplar; bu yüzden sadece EN DIŞTAKİ
      // (ebeveyni pointer OLMAYAN) elementi adaya ekliyoruz — aksi halde aynı tıklanabilir bölge
      // için onlarca iç içe/gereksiz aday üretilirdi.
      //
      // Performans notu: getComputedStyle() her element için maliyetlidir; bu yüzden bu kontrolü
      // SADECE INTERACTIVE_SELECTOR ile zaten eşleşmemiş elementler için çalıştırıyoruz.
      if (!seen.has(el) && window.getComputedStyle(el).cursor === 'pointer') {
        const parent = el.parentElement;
        const parentAlsoPointer = parent ? window.getComputedStyle(parent).cursor === 'pointer' : false;
        if (!parentAlsoPointer) {
          seen.add(el);
          candidates.push(el);
        }
      }
    });
  }

  collect(document);

  function isVisible(el: Element): { visible: boolean; inViewport: boolean; rect: DOMRect } {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const hasSize = rect.width > 0 && rect.height > 0;
    const cssVisible = style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || '1') > 0;
    const visible = hasSize && cssVisible;
    const inViewport =
      visible &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < (window.innerHeight || document.documentElement.clientHeight) &&
      rect.left < (window.innerWidth || document.documentElement.clientWidth);
    return { visible, inViewport, rect };
  }

  function isEnabled(el: Element): boolean {
    const disabled = (el as HTMLInputElement).disabled === true;
    const ariaDisabled = el.getAttribute('aria-disabled') === 'true';
    return !disabled && !ariaDisabled;
  }

  function computeAccessibleName(el: Element): string | null {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean);
      if (parts.length) return parts.join(' ').slice(0, 200);
    }

    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const id = el.getAttribute('id');
      if (id) {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (label?.textContent) return label.textContent.trim().slice(0, 200);
      }
      const closestLabel = el.closest('label');
      if (closestLabel?.textContent) return closestLabel.textContent.trim().slice(0, 200);
    }

    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder.trim();

    const title = el.getAttribute('title');
    if (title) return title.trim();

    const alt = el.getAttribute('alt');
    if (alt) return alt.trim();

    if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'submit') {
      return (el as HTMLInputElement).value || 'Gönder';
    }

    // hepsiburada.com üzerinde canlı olarak gözlemlendi: bir <select>'in (ör. "sırala" dropdown'ı)
    // ham textContent'i, TÜM <option>'larının metninin ARA BOŞLUKSUZ birleşimidir (örn.
    // "Önerilen sıralamaEn düşük fiyatEn yüksek fiyat..."). Bu ne okunabilir bir isimdir NE DE
    // gerçek bir erişilebilir ad — tarayıcıların kendi erişilebilirlik ağaçları da bir <select>'e
    // böyle bir ad vermez. LLM bu garip birleşik metni gördüğünde sıralama seçeneklerinin gerçekte
    // NELER olduğunu anlayamadı ve doğru seçeneği (select_option için doğru "value") bulamadan
    // ask_clarification ile güvenli şekilde durdu. Bunun yerine seçili seçeneğin metni zaten ayrı
    // bir alanda (`currentValue`) taşınıyor, TÜM seçenek listesi de ayrı, düzgün biçimlendirilmiş
    // bir `options` dizisinde veriliyor (bkz. RawDiscoveredElement.options) — bu yüzden burada
    // BİLEREK `null` dönüyoruz, genel textContent fallback'ine hiç düşmüyoruz.
    if (el.tagName === 'SELECT') return null;

    const text = el.textContent?.trim();
    if (text) return text.slice(0, 200);

    return null;
  }

  function implicitRole(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return tag;
  }

  function relevantAttributes(el: Element): Record<string, string> {
    const attrs: Record<string, string> = {};
    const keep = ['type', 'name', 'placeholder', 'href', 'checked', 'aria-checked', 'aria-expanded', 'value', 'maxlength', 'required'];
    for (const key of keep) {
      const v = el.getAttribute(key);
      if (v !== null) {
        attrs[key] = key === 'href' && v.length > 200 ? v.slice(0, 200) + '…' : v;
      }
    }
    return attrs;
  }

  // ---- Görünür ama TIKLANABİLİR OLMAYAN hata/uyarı/bildirim metinlerini topla ----
  // (bkz. DiscoveryResult.alerts / PageSnapshot.alerts dosya başı açıklaması). hepsiburada.com
  // üzerinde canlı olarak gözlemlendi: bir giriş formu "Beklenmeyen bir hata oluştu" mesajı
  // gösterdi ama bu metin interaktif olmadığı için `candidates` listesine hiç girmedi — ajan
  // hatayı GÖREMEDİĞİ için aynı butona körü körüne tekrar tekrar tıkladı. Bu, `candidates`'tan
  // TAMAMEN BAĞIMSIZ, ayrı bir toplama; bir hata kutusunun içindeki "X" (kapat) butonu zaten
  // normal interaktif element keşfinden ayrıca çıkar, burada sadece MESAJ METNİ ilgileniyoruz.
  //
  // Bilinçli tasarım: bu SADECE bir bilgi/gözlem sinyalidir (LLM'e "sayfada böyle bir metin var"
  // diye gösterilir) — hiçbir aksiyonu doğrudan TETİKLEMEZ ve hiçbir elementle etkileşime girmez,
  // bu yüzden yanlış pozitif (alakasız bir "bildirim ayarları" linkinin yakalanması gibi) riski
  // güvenlik açısından ZARARSIZDIR, en kötü ihtimalle gereksiz bir bilgi satırı gösterir.
  // hepsiburada.com üzerinde canlı olarak doğrulandı: gerçek hata kutusunun CSS class'ları
  // ("hb-fzplVX GNCXF s42jgutvdqt" gibi) bir derleme aracı tarafından üretilmiş, ANLAMSIZ
  // (hashlenmiş) isimlerdi — "error"/"alert" gibi hiçbir anahtar kelime İÇERMİYORDU, bu yüzden
  // sadece class'a bakan yukarıdaki desenler bunu YAKALAYAMADI. Ama elementin `data-test-id`
  // attribute'u anlamlıydı: "inline-alert-label". Bu, gerçek dünyada ÇOK YAYGIN bir desendir —
  // birçok site CSS class'larını obfuscate eder ama test/otomasyon amaçlı data-test-id/data-testid/
  // data-qa/data-cy attribute'larını İNSAN OKUNABİLİR bırakır (tam da bu tür otomasyonlara yardımcı
  // olmak için). Bu yüzden bu attribute'ları da anahtar kelime bazlı olarak tarıyoruz.
  const ALERT_ATTR_NAMES = ['data-test-id', 'data-testid', 'data-qa', 'data-cy'];
  const ALERT_KEYWORDS = ['alert', 'error', 'warning', 'toast', 'hata', 'uyari'];
  const ALERT_ATTR_SELECTORS = ALERT_ATTR_NAMES.flatMap((attr) => ALERT_KEYWORDS.map((kw) => `[${attr}*="${kw}" i]`));

  const ALERT_SELECTOR = [
    '[role="alert"]',
    '[role="status"]',
    '[aria-live="assertive"]',
    '[aria-live="polite"]',
    '[class*="error" i]',
    '[class*="alert" i]',
    '[class*="warning" i]',
    '[class*="toast" i]',
    '[class*="hata" i]',
    '[class*="uyari" i]',
    ...ALERT_ATTR_SELECTORS,
  ].join(',');

  const alerts: string[] = [];
  const seenAlertText = new Set<string>();
  function collectAlerts(root: Document | ShadowRoot) {
    root.querySelectorAll(ALERT_SELECTOR).forEach((el) => {
      if (alerts.length >= 5) return; // gürültüyü sınırla
      if (!isVisible(el).visible) return;
      const text = el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 200);
      if (!text || text.length < 3 || seenAlertText.has(text)) return;
      seenAlertText.add(text);
      alerts.push(text);
    });
    root.querySelectorAll('*').forEach((el) => {
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) collectAlerts(shadow);
    });
  }
  collectAlerts(document);

  const scored = candidates
    .map((el) => {
      const { visible, inViewport } = isVisible(el);
      return { el, visible, inViewport };
    })
    .filter((c) => c.visible)
    .sort((a, b) => {
      if (a.inViewport !== b.inViewport) return a.inViewport ? -1 : 1;
      return 0;
    });

  const limited = scored.slice(0, maxElements);

  const elements: RawDiscoveredElement[] = limited.map((c, i) => {
    const ref = `e${startIndex + i}`;
    c.el.setAttribute('data-ai-ref', ref);

    const tagName = c.el.tagName.toLowerCase();
    let currentValue: string | undefined;
    let options: string[] | undefined;
    if (tagName === 'input' || tagName === 'textarea') {
      const v = (c.el as HTMLInputElement | HTMLTextAreaElement).value;
      if (v) currentValue = v.length > 200 ? v.slice(0, 200) + '…' : v;
    } else if (tagName === 'select') {
      currentValue = (c.el as HTMLSelectElement).selectedOptions[0]?.textContent?.trim();

      // hepsiburada.com üzerinde canlı olarak gözlemlendi: bir "sırala" <select>'i keşfediliyordu
      // ama LLM'e sadece SEÇİLİ değer ("Önerilen sıralama") gösteriliyordu — diğer seçeneklerin
      // (ör. "En düşük fiyat") VAR OLDUĞUNU bile bilemedi, select_option için hangi "value"yu
      // yazması gerektiğini bulamadı ve güvenli şekilde ask_clarification ile durdu. Artık TÜM
      // seçenek metinlerini ayrı bir listede veriyoruz — makul bir üst sınırla (25 seçenek, her
      // biri kısaltılmış), aşırı uzun bir <select> (ör. "ülke seçin") prompt'u şişirmesin diye.
      const optionTexts = Array.from((c.el as HTMLSelectElement).options)
        .map((o) => o.textContent?.trim())
        .filter((t): t is string => Boolean(t))
        .map((t) => (t.length > 60 ? t.slice(0, 59) + '…' : t));
      if (optionTexts.length) options = optionTexts.slice(0, 25);
    }

    const rawText = c.el.textContent?.trim() ?? '';

    return {
      ref,
      tag: tagName,
      role: implicitRole(c.el),
      accessibleName: computeAccessibleName(c.el),
      text: rawText ? rawText.slice(0, 200) : null,
      attributes: relevantAttributes(c.el),
      visible: c.visible,
      enabled: isEnabled(c.el),
      inViewport: c.inViewport,
      currentValue,
      options,
    };
  });

  return {
    elements,
    totalCandidates: candidates.length,
    nextIndex: startIndex + elements.length,
    alerts,
  };
}
