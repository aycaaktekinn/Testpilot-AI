import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page, type Video } from 'playwright';
import type { RunOptions } from '../../domain/types.js';
import { env } from '../../config/env.js';
import { SeleniumGridError } from '../../domain/errors.js';
import { SeleniumGridClient } from './SeleniumGridClient.js';
import { getGlobalSettings } from '../../db/globalSettingsStore.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('BrowserManager');

const ENGINES = { chromium, firefox, webkit } as const;

const CHROMIUM_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface CloseResult {
  /** Video kaydı istenmişse ve başarıyla diske yazıldıysa, dosyanın mutlak yolu. */
  videoPath?: string;
}

/**
 * Tek bir test run'ı için browser / context / page yaşam döngüsünü yönetir.
 * Generic'tir: herhangi bir siteye özel varsayım içermez. chromium/firefox/webkit motorlarını,
 * video kaydını ve Playwright trace toplamayı destekler (hepsi opsiyoneldir).
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private video: Video | null = null;
  private tracingStarted = false;

  // v2.0 — Selenium Grid modunda açılan session'ı close()'da Grid havuzuna geri bırakmak için
  // saklanır (bkz. SeleniumGridClient.deleteSession dosya başı açıklaması). Yerel (Grid'siz)
  // koşumlarda ikisi de null kalır.
  private gridClient: SeleniumGridClient | null = null;
  private gridSessionId: string | null = null;
  // v2.2 — SADECE Grid modunda VE env.SELENIUM_GRID_NODE_VNC_MAP'te bu node için bir eşleme
  // varsa doludur (bkz. SeleniumGridClient.GridSession.liveViewUrl dosya başı açıklaması).
  private gridLiveViewUrl: string | null = null;

  // v2.3 — bkz. adoptNewestPageIfOpened dosya başı NOT'u. Yeni açılan bir sekmenin GERÇEKTEN bir
  // yere navigasyon yapıp yapmadığını anlamak için tanınan azami süre ve poll aralığı — gerçek bir
  // target="_blank" linki neredeyse anında navigasyona başlar, bir reklam/izleme pop-under'ı ise
  // genelde about:blank/data: URI'de süresiz kalır. Süre kısa tutuldu (adım başına gecikmeyi
  // sınırlamak için) ama gerçek yavaş-başlayan navigasyonları da yanlışlıkla "ölü" saymayacak kadar
  // uzun.
  private static readonly BLANK_TAB_GRACE_MS = 1200;
  private static readonly BLANK_TAB_POLL_INTERVAL_MS = 150;

  /**
   * @param videoDir Video kaydı isteniyorsa (options.captureVideo), Playwright'ın .webm dosyasını
   *   yazacağı klasör. Klasörün var olduğu çağıran tarafından garanti edilmelidir.
   * @param storageState v3.3 — verilirse yeni context bu çerez/localStorage durumuyla BAŞLAR (bkz.
   *   getStorageState dosya başı açıklaması). Senaryo Önerileri'ndeki login ön-adımından sonra,
   *   taramayı YENİ bir (ama zaten giriş yapılmış) context ile devam ettirmek için kullanılır.
   *   Verilmezse (varsayılan, TÜM normal test run'larında olduğu gibi) davranış AYNEN korunur —
   *   Playwright boş/anonim bir context açar.
   */
  async launch(
    options: RunOptions,
    videoDir?: string,
    storageState?: Awaited<ReturnType<BrowserContext['storageState']>>,
  ): Promise<Page> {
    // v3.2 — bkz. sohbet notu: "test için chrome sekmesi açılıyor ya o sekme tam ekran olsun".
    // SADECE headed (görünür) + yerel (Selenium Grid'siz) + Chromium koşumlarında anlamlı: pencere
    // gerçekten görünür olduğu için kullanıcı onu küçük sabit boyutlu (1366x900) bir pencere
    // yerine ekranı kaplamış görmek istiyor. Headless koşumlarda (görünür pencere YOK), Grid'de
    // (uzak node kendi ekranını kullanır) ya da Firefox/WebKit'te (`--start-maximized` Chromium'a
    // özgü bir flag, karşılığı yok) BİLİNÇLİ OLARAK dokunulmuyor.
    const shouldMaximize = !options.useSeleniumGrid && !options.headless && options.browserEngine === 'chromium';

    if (options.useSeleniumGrid) {
      this.browser = await this.launchViaSeleniumGrid(options);
    } else {
      const launcher = ENGINES[options.browserEngine];
      this.browser = await launcher.launch({
        headless: options.headless,
        ...(shouldMaximize ? { args: ['--start-maximized'] } : {}),
      });
    }

    this.context = await this.browser.newContext({
      // `--start-maximized` sadece PENCEREYİ maksimize eder; Playwright'a yine sabit bir viewport
      // (1366x900) verilmeye devam edilirse sayfa içeriği eski küçük boyutunda kalır (pencere
      // büyük ama içerik ortada, kenarlarda boşluk) — bu yüzden bu durumda viewport'u BİLEREK
      // `null` bırakıyoruz, böylece sayfa gerçek (maksimize edilmiş) pencere boyutuna göre render
      // olur. Headless/Grid/diğer motorlarda davranış AYNEN korunur (sabit viewport, ekran
      // koordinatlarının/AI element keşfinin tutarlılığı için).
      viewport: shouldMaximize ? null : options.viewport,
      // Sadece Chromium için gerçekçi bir masaüstü Chrome user-agent'ı kullanıyoruz; diğer
      // motorlarda kendi varsayılan (ve tutarlı) user-agent'ları bırakılıyor.
      ...(options.browserEngine === 'chromium' ? { userAgent: CHROMIUM_USER_AGENT } : {}),
      ...(options.captureVideo && videoDir ? { recordVideo: { dir: videoDir, size: options.viewport } } : {}),
      ...(storageState ? { storageState } : {}),
    });
    this.context.setDefaultTimeout(options.defaultActionTimeoutMs);
    this.context.setDefaultNavigationTimeout(options.navigationTimeoutMs);

    if (options.captureTrace) {
      await this.context.tracing.start({ screenshots: true, snapshots: true });
      this.tracingStarted = true;
    }

    this.page = await this.context.newPage();
    this.video = this.page.video();
    this.attachDialogHandler(this.page);

    if (shouldMaximize) {
      await this.maximizeWindow(this.page);
    }

    return this.page;
  }

  /**
   * v3.2 — DÜZELTME 3: kullanıcı "maximized" (pencere ekranı kaplar ama menü çubuğu/dock görünür
   * kalır) değil, GERÇEK OS-seviyesi fullscreen istedi (bkz. sohbet notu: "full screen istmiştim").
   * Önceki denemeler (`--start-maximized` flag'i, CDP `windowState:'maximized'`, somut piksel
   * boyutuna resize) sırasıyla denendi ama hiçbiri macOS'ta gerçek fullscreen VERMEDİ — çünkü
   * macOS'ta "maximize" native bir pencere durumu DEĞİLDİR (yerine "zoom" var). "fullscreen" İSE
   * (yeşil butona çift tıklama / Cmd+Ctrl+F ile açılan, menü çubuğu ve dock'un da kaybolduğu mod)
   * macOS'ta native olarak DESTEKLENİYOR — bu yüzden CDP'ye doğrudan bu durumu istettiriyoruz.
   */
  private async maximizeWindow(page: Page): Promise<void> {
    try {
      const cdpSession = await this.context!.newCDPSession(page);
      const { windowId } = await cdpSession.send('Browser.getWindowForTarget');
      // Önce 'normal' durumuna alıyoruz — pencere zaten farklı bir state'teyse doğrudan
      // 'fullscreen' istemek CDP tarafından yok sayılabiliyor; 'normal'a çekip HEMEN ARDINDAN
      // fullscreen istemek bu riski ortadan kaldırıyor.
      await cdpSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });

      try {
        await cdpSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
      } catch (fullscreenErr) {
        // Best-effort geri düşüş: fullscreen state bir sebeple reddedilirse (ör. eski bir
        // Chromium sürümü/platform), en azından ekranın gerçek çözünürlüğüne göre somut piksel
        // değerleriyle büyütmeyi dene — hiç büyütememekten iyidir.
        log.warn({ err: fullscreenErr }, 'Fullscreen durumu ayarlanamadı, somut ekran boyutuna büyütme deneniyor');
        // NOT: bu callback Node'da DEĞİL, page.evaluate() ile TARAYICIDA çalışır (bkz.
        // browserDiscoveryScript.ts dosya başı NOT'undaki AYNI durum) — bu projenin tsconfig'i
        // BİLİNÇLİ OLARAK "DOM" lib'ini içermediği için `window`/`screen` burada TypeScript'e
        // tanımsız görünür; tip zorlamasıyla bu kontrolü es geçiyoruz.
        const { width, height } = await page.evaluate(() => {
          const s = (globalThis as unknown as { screen: { width: number; height: number } }).screen;
          return { width: s.width, height: s.height };
        });
        await cdpSession.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width, height } });
      }
    } catch (err) {
      log.warn({ err }, 'Tarayıcı penceresi tam ekran yapılamadı (görsel bir sorun, testi etkilemez)');
    }
  }

  /**
   * v2.0 — yerel `launcher.launch()` yerine bir Selenium Grid node'una bağlanır (bkz.
   * SeleniumGridClient dosya başı açıklaması). SADECE Chromium için desteklenir: Firefox/WebKit
   * Grid node'ları saf WebDriver protokolü konuşur, Playwright'ın bu motorlara ait sürücüleri CDP
   * KONUŞMAZ — bu kombinasyon sessizce yerel bir tarayıcıya düşmek yerine BİLİNÇLİ OLARAK net bir
   * hatayla durdurulur (aksi halde kullanıcı "Grid kullanıyorum" sanıp aslında yerelde koştuğunu
   * fark etmeyebilir).
   */
  private async launchViaSeleniumGrid(options: RunOptions): Promise<Browser> {
    if (options.browserEngine !== 'chromium') {
      throw new SeleniumGridError(
        `Selenium Grid SADECE Chromium için desteklenir (Firefox/WebKit Grid node'ları saf WebDriver ` +
          `protokolü konuşur, Playwright bunlara CDP üzerinden bağlanamaz). Seçilen motor: "${options.browserEngine}".`,
      );
    }

    const gridUrl = await this.resolveGridUrl();

    this.gridClient = new SeleniumGridClient(gridUrl);
    const session = await this.gridClient.createSession();
    this.gridSessionId = session.sessionId;
    this.gridLiveViewUrl = session.liveViewUrl ?? null;

    return await chromium.connectOverCDP(session.cdpUrl);
  }

  /**
   * v3.0 Faz 5 — hangi Grid hub'ına bağlanılacağını belirler. ÖNCELİK SIRASI:
   *   1) Admin Panel'den ayarlanan global Grid URL (Oracle yapılandırılmışsa VE bir değer
   *      kaydedilmişse) — backend'i yeniden başlatmadan değiştirilebilir, bu yüzden ÖNCELİKLİDİR.
   *   2) .env dosyasındaki SELENIUM_GRID_URL — GERİYE DÖNÜK UYUMLULUK: Oracle/admin panel HİÇ
   *      kullanılmıyorsa (ya da DB'de henüz hiç ayar kaydedilmemişse) bu değer kullanılır.
   *
   * NEDEN eskiden (Faz 1) eklenen WEB_PROJECTS.GRID_URL sütunu BURADA KULLANILMIYOR: sohbette fark
   * edildi ki o alan hiçbir zaman run yürütme koduna bağlanmamıştı (admin panelde saklanıyordu ama
   * okunmuyordu) — kullanıcı proje bazlı yerine TEK/sabit bir Grid URL istedi, bu yüzden proje
   * bazlı alan KALDIRILDI (bkz. adminProjects.ts/projectStore.ts dosya başı NOT'ları), yerine bu
   * TEK global ayar geçti.
   *
   * DB okuma HATA VERİRSE (ör. geçici bağlantı sorunu) run'ı ÇÖKERTMEMEK için sessizce .env
   * değerine düşülür — bu metodun TEK amacı hangi hub'a bağlanılacağını bulmak, burada oluşan bir
   * hata run'ı BAŞLAMADAN engellemesin.
   */
  private async resolveGridUrl(): Promise<string> {
    if (env.ORACLE_DB_HOST) {
      try {
        const settings = await getGlobalSettings();
        if (settings?.gridUrl) {
          return settings.gridUrl;
        }
      } catch (err) {
        log.warn({ err }, 'Global Grid URL ayarı (Admin Panel) okunamadı, .env değerine düşülüyor');
      }
    }

    if (!env.SELENIUM_GRID_URL) {
      throw new SeleniumGridError(
        'Selenium Grid istendi ama hiçbir Grid URL yapılandırılmamış (ne Admin Panel\'de ne .env\'de). ' +
          'Admin Panel\'den (Oracle yapılandırılmışsa) ya da .env dosyasındaki SELENIUM_GRID_URL ile ayarlayın.',
      );
    }
    return env.SELENIUM_GRID_URL;
  }

  /** v2.2 — bkz. gridLiveViewUrl dosya başı açıklaması. Grid kullanılmıyorsa (ya da eşleme yoksa) `null`. */
  getGridLiveViewUrl(): string | null {
    return this.gridLiveViewUrl;
  }

  getPage(): Page {
    if (!this.page) throw new Error('BrowserManager henüz başlatılmadı (launch çağrılmadı).');
    return this.page;
  }

  /**
   * v3.3 — Senaryo Önerileri'ndeki AI destekli login ön-adımı için eklendi (bkz.
   * ScenarioSuggester.performLogin dosya başı açıklaması). Context'in o anki çerez/localStorage
   * durumunu (Playwright storageState) döner — bu, başka bir BrowserManager'ın YENİ bir context'i
   * `launch(options, videoDir, storageState)` ile bu durumdan başlatabilmesini sağlar (ör. giriş
   * yapılmış bir oturumla devam edip sayfayı taramak). NOT: dönen değer çerezleri (potansiyel
   * olarak bir session token) içerir — ASLA loglanmamalı, diske yazılmamalı ya da genel bir WS
   * yayın kanalına gönderilmemelidir; sadece process içinde, çağıranın kendi belleğinde
   * kullanılmalıdır. context kapatılmadan ÖNCE çağrılmalıdır. Best-effort: context yoksa ya da bir
   * hata olursa null döner (asla fırlatmaz).
   */
  async getStorageState(): Promise<Awaited<ReturnType<BrowserContext['storageState']>> | null> {
    if (!this.context) return null;
    try {
      return await this.context.storageState();
    } catch (err) {
      log.debug({ err }, 'Oturum durumu (storageState) alınamadı (yok sayıldı)');
      return null;
    }
  }

  private attachDialogHandler(page: Page): void {
    page.on('dialog', (dialog) => {
      // Yönetilmeyen JS dialog'ları (alert/confirm/prompt) akışı kilitler; güvenli tarafta
      // kalmak için otomatik olarak kapatıyoruz ve bunu log'a yazıyoruz.
      log.warn({ type: dialog.type(), message: dialog.message() }, 'Beklenmeyen JS dialog otomatik kapatıldı');
      void dialog.dismiss();
    });
  }

  /**
   * Bir aksiyon (ör. `target="_blank"` ile açılan bir ürün linkine tıklama — hepsiburada.com'da
   * canlı olarak gözlemlendi: ürün kartı linki yeni SEKMEDE açılıyor, orijinal sekmenin URL'si
   * hiç değişmiyor) sonucunda YENİ bir sekme/pencere açılmışsa, aktif `page` referansını o yeni
   * sekmeye geçirir ve eskisini kapatır. Bu olmadan ajan, artık "arkaplanda kalmış" eski sekmeyi
   * taramaya devam eder — orada hiçbir şey değişmediği için aynı elemente tekrar tekrar tıklamaya
   * çalışır ve sonunda döngü korumasına takılır (tam olarak yaşanan sorun buydu).
   *
   * v2.3 — YENİ sekme hâlâ boşsa (about:blank/data:), onu KÖRÜ KÖRÜNE "ilgilenilen yeni sekme"
   * sayıp eski (asıl kullanışlı) sekmeyi kapatmak TEHLİKELİDİR: hepsiburada.com üzerinde canlı
   * olarak gözlemlendi — bir tıklama, boş bir sekme açan bir reklam/izleme pop-under'ı tetikledi,
   * kod bu boş sekmeye geçip eski sekmeyi kapattı, ajan artık var olmayan elementleri aramaya
   * çalışıp başarısız oldu. Bu yüzden yeni sekme boşsa önce `waitForRealNavigation` ile kısa bir
   * süre gerçekten bir yere gidip gitmediğine bakılır (bkz. BLANK_TAB_GRACE_MS); hâlâ boşsa "ölü"
   * kabul edilip SADECE O sekme kapatılır, aktif sayfa DEĞİŞMEZ (asıl sekme korunur).
   *
   * Döner: sayfa gerçekten değiştiyse `true`, yeni bir sekme yoksa (ya da boş çıkıp yok sayıldıysa) `false`.
   */
  async adoptNewestPageIfOpened(): Promise<boolean> {
    if (!this.context || !this.page) return false;
    const pages = this.context.pages();
    if (pages.length <= 1) return false;

    // En son açılan sekmeyi "ilgilenilen" yeni sekme olarak kabul ediyoruz — bir click aksiyonunun
    // DOĞRUDAN sonucu olarak açılmış olması en olası senaryo budur.
    const newest = pages[pages.length - 1];
    if (!newest || newest === this.page) return false;

    if (this.isBlankUrl(newest.url())) {
      const navigatedSomewhere = await this.waitForRealNavigation(newest);
      if (!navigatedSomewhere) {
        log.debug(
          { url: newest.url() },
          'Yeni açılan sekme boş kaldı (muhtemelen bir pop-under/izleme sekmesi), yok sayılıp kapatıldı',
        );
        await newest.close().catch(() => undefined);
        return false;
      }
    }

    // Sadece bir önceki aktif sekmeyi değil, o ana kadar (ör. bir reklam pop-under'ı gibi önceki
    // adımlarda açılıp hiç kapatılmamış) BİRİKMİŞ olabilecek TÜM diğer sekmeleri kapatıyoruz.
    // Aksi halde bu "yetim" sekmeler süresiz birikir (kaynak sızıntısı) — ayrıca context.pages()'ın
    // her zaman "en son eleman = ilgilenilen yeni sekme" varsayımını, eski bir sekme farklı bir
    // sırada kalarak bozabileceği ihtimalini de ortadan kaldırır.
    const staleTabs = pages.filter((p) => p !== newest);

    this.page = newest;
    this.video = newest.video();
    this.attachDialogHandler(newest);

    // Yeni sekme henüz yüklenmeye başlamamış olabilir; kısa bir yükleme beklemesi (best-effort,
    // başarısız olursa sorun değil — bir sonraki adımdaki normal navigasyon-yerleşme mantığı zaten
    // devreye girecek).
    await newest.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);

    await Promise.all(staleTabs.map((p) => p.close().catch(() => undefined)));

    return true;
  }

  /** v2.3 — bkz. adoptNewestPageIfOpened dosya başı NOT'u. "about:blank" ya da "data:" ile başlayan bir URL, henüz hiçbir yere navigasyon yapmamış bir sekmeye işaret eder. */
  private isBlankUrl(url: string): boolean {
    return url === 'about:blank' || url.startsWith('data:');
  }

  /**
   * v2.3 — verilen sayfanın URL'sinin, BLANK_TAB_GRACE_MS içinde boş (about:blank/data:) OLMAKTAN
   * ÇIKIP ÇIKMADIĞINI (yani gerçekten bir yere navigasyon başlatıp başlatmadığını) poll ederek
   * kontrol eder. Gerçek bir target="_blank" linki genelde ilk poll turunda bile yakalanır; bir
   * pop-under ise süre dolana kadar boş kalır.
   */
  private async waitForRealNavigation(page: Page): Promise<boolean> {
    const deadline = Date.now() + BrowserManager.BLANK_TAB_GRACE_MS;
    while (Date.now() < deadline) {
      if (!this.isBlankUrl(page.url())) return true;
      // Sayfa bu sırada kapanmış olabilir (ör. pop-under kendi kendini kapattı) — bu durumda
      // page.url() erişimi Playwright tarafında genelde son bilinen değeri döner, fırlatmaz; yine
      // de best-effort bir gecikme sonrası tekrar kontrol ediyoruz.
      await new Promise((resolve) => setTimeout(resolve, BrowserManager.BLANK_TAB_POLL_INTERVAL_MS));
    }
    return !this.isBlankUrl(page.url());
  }

  /** Sayfanın tam ekran görüntüsünü verilen yola kaydeder. Page/context hâlâ açıkken çağrılmalıdır. */
  async captureScreenshot(destinationPath: string): Promise<boolean> {
    try {
      if (!this.page) return false;
      await this.page.screenshot({ path: destinationPath, fullPage: true, timeout: 10000 });
      return true;
    } catch (err) {
      log.debug({ err }, 'Ekran görüntüsü alınamadı (yok sayıldı)');
      return false;
    }
  }

  /** Trace toplama başlatıldıysa durdurur ve verilen yola .zip olarak yazar. Context kapatılmadan önce çağrılmalıdır. */
  async stopTracing(destinationPath: string): Promise<boolean> {
    if (!this.tracingStarted || !this.context) return false;
    try {
      await this.context.tracing.stop({ path: destinationPath });
      return true;
    } catch (err) {
      log.debug({ err }, 'Trace durdurulamadı (yok sayıldı)');
      return false;
    } finally {
      this.tracingStarted = false;
    }
  }

  /**
   * page/context/browser'ı sırasıyla kapatır. Video kaydı istenmişse, dosya kapanış sonrası
   * diske tam olarak yazıldığında yolunu döner (Playwright videoyu context kapanana kadar finalize etmez).
   */
  async close(): Promise<CloseResult> {
    try {
      await this.page?.close();
    } catch (err) {
      log.debug({ err }, 'page kapatılırken hata (yok sayıldı)');
    }
    try {
      await this.context?.close();
    } catch (err) {
      log.debug({ err }, 'context kapatılırken hata (yok sayıldı)');
    }

    let videoPath: string | undefined;
    if (this.video) {
      try {
        videoPath = await this.video.path();
      } catch (err) {
        log.debug({ err }, 'Video yolu alınamadı (yok sayıldı)');
      }
    }

    try {
      await this.browser?.close();
    } catch (err) {
      log.debug({ err }, 'browser kapatılırken hata (yok sayıldı)');
    }

    // v2.0 — Grid modunda browser.close() sadece CDP bağlantısını keser, node'u Grid havuzuna
    // GERİ BIRAKMAZ; bu SADECE WebDriver session'ı DELETE ederek olur (bkz. SeleniumGridClient
    // dosya başı açıklaması). Best-effort'tur — asla fırlatmaz, run'ın PASS/FAIL sonucunu etkilemez.
    if (this.gridClient && this.gridSessionId) {
      await this.gridClient.deleteSession(this.gridSessionId);
    }

    this.page = null;
    this.context = null;
    this.browser = null;
    this.video = null;
    this.gridClient = null;
    this.gridSessionId = null;

    return { videoPath };
  }
}
