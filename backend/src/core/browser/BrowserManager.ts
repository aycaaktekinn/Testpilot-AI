import { chromium, firefox, webkit, type Browser, type BrowserContext, type Page, type Video } from 'playwright';
import type { RunOptions } from '../../domain/types.js';
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

  /**
   * @param videoDir Video kaydı isteniyorsa (options.captureVideo), Playwright'ın .webm dosyasını
   *   yazacağı klasör. Klasörün var olduğu çağıran tarafından garanti edilmelidir.
   */
  async launch(options: RunOptions, videoDir?: string): Promise<Page> {
    const launcher = ENGINES[options.browserEngine];
    this.browser = await launcher.launch({ headless: options.headless });

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
   * Döner: sayfa gerçekten değiştiyse `true`, yeni bir sekme yoksa `false`.
   */
  async adoptNewestPageIfOpened(): Promise<boolean> {
    if (!this.context || !this.page) return false;
    const pages = this.context.pages();
    if (pages.length <= 1) return false;

    // En son açılan sekmeyi "ilgilenilen" yeni sekme olarak kabul ediyoruz — bir click aksiyonunun
    // DOĞRUDAN sonucu olarak açılmış olması en olası senaryo budur.
    const newest = pages[pages.length - 1];
    if (!newest || newest === this.page) return false;

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

    this.page = null;
    this.context = null;
    this.browser = null;
    this.video = null;

    return { videoPath };
  }
}
