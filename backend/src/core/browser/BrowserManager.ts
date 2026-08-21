import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page, type Video } from 'playwright';
import type { RunOptions } from '../../domain/types.js';
import { env } from '../../config/env.js';
import { SeleniumGridError } from '../../domain/errors.js';
import { SeleniumGridClient } from './SeleniumGridClient.js';
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
   */
  async launch(options: RunOptions, videoDir?: string): Promise<Page> {
    if (options.useSeleniumGrid) {
      this.browser = await this.launchViaSeleniumGrid(options);
    } else {
      const launcher = ENGINES[options.browserEngine];
      this.browser = await launcher.launch({ headless: options.headless });
    }

    this.context = await this.browser.newContext({
      viewport: options.viewport,
      // Sadece Chromium için gerçekçi bir masaüstü Chrome user-agent'ı kullanıyoruz; diğer
      // motorlarda kendi varsayılan (ve tutarlı) user-agent'ları bırakılıyor.
      ...(options.browserEngine === 'chromium' ? { userAgent: CHROMIUM_USER_AGENT } : {}),
      ...(options.captureVideo && videoDir ? { recordVideo: { dir: videoDir, size: options.viewport } } : {}),
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

    return this.page;
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

    if (!env.SELENIUM_GRID_URL) {
      throw new SeleniumGridError(
        'Selenium Grid istendi ama SELENIUM_GRID_URL .env dosyasında tanımlı değil. Grid hub adresini ' +
          '.env dosyasına ekleyip backend\'i yeniden başlatın.',
      );
    }

    this.gridClient = new SeleniumGridClient(env.SELENIUM_GRID_URL);
    const session = await this.gridClient.createSession();
    this.gridSessionId = session.sessionId;
    this.gridLiveViewUrl = session.liveViewUrl ?? null;

    return await chromium.connectOverCDP(session.cdpUrl);
  }

  /** v2.2 — bkz. gridLiveViewUrl dosya başı açıklaması. Grid kullanılmıyorsa (ya da eşleme yoksa) `null`. */
  getGridLiveViewUrl(): string | null {
    return this.gridLiveViewUrl;
  }

  getPage(): Page {
    if (!this.page) throw new Error('BrowserManager henüz başlatılmadı (launch çağrılmadı).');
    return this.page;
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
