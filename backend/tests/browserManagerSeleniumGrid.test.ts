import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseEnv } from './helpers/fakeEnv.js';

const ENV_MODULE = '../src/config/env.js';
const PLAYWRIGHT_MODULE = 'playwright';

const HUB_URL = 'http://grid-hub.local:4444';

const baseOptions = {
  maxSteps: 5,
  headless: true,
  stepTimeoutMs: 5000,
  navigationTimeoutMs: 5000,
  defaultActionTimeoutMs: 5000,
  maxElementsPerStep: 20,
  maxRepeatedActions: 3,
  minConfidence: 0.5,
  viewport: { width: 1366, height: 900 },
  browserEngine: 'chromium' as const,
  captureScreenshot: false,
  captureVideo: false,
  captureTrace: false,
  useSeleniumGrid: true,
};

/**
 * `browserManager.test.ts`'ten BİLEREK ayrı bir dosya: o dosya TÜM testler için TEK bir paylaşılan
 * env mock'u kullanıyor (bkz. o dosyanın dosya başı NOT'u). Burada ise SELENIUM_GRID_URL'in
 * tanımlı/tanımsız olduğu farklı senaryoları test etmemiz gerekiyor — bu yüzden testRunStore.test.ts
 * ile aynı "her testte resetModules + yeniden import" deseni kullanılıyor.
 */
describe('BrowserManager — Selenium Grid entegrasyonu (v2.0)', () => {
  afterEach(() => {
    vi.doUnmock(ENV_MODULE);
    vi.doUnmock(PLAYWRIGHT_MODULE);
    vi.resetModules();
    vi.restoreAllMocks();
  });

  // ÖNEMLİ (gerçek `npm test` ile YAKALANAN bir hata — sandbox tsc bunu göremez, tip düzeyinde
  // görünmez): `SeleniumGridError`'ı dosya başında STATİK import edip, test edilen modülü
  // (`BrowserManager.js`) her testte `vi.resetModules()` sonrası DİNAMİK import etmek, iki farklı
  // modül kaydından (module registry) gelen İKİ FARKLI `SeleniumGridError` sınıfı üretir — aynı isim/
  // şekle sahip olsalar bile `instanceof` FARKLI nesneler olduğu için başarısız olur. Çözüm: bu
  // codebase'in zaten kurulu deseni (bkz. testRunStore.test.ts/scenarioSuggester.test.ts/
  // geminiProvider.test.ts) — hata sınıfını da AYNI dinamik import çağrısıyla, test edilen modülle
  // AYNI "taze" modül kaydından almak.
  async function loadWithEnv(envOverrides: Record<string, unknown> = {}) {
    vi.doMock(ENV_MODULE, () => ({ env: baseEnv(envOverrides) }));
    const { BrowserManager } = await import('../src/core/browser/BrowserManager.js');
    const { SeleniumGridError } = await import('../src/domain/errors.js');
    return { BrowserManager, SeleniumGridError };
  }

  it('useSeleniumGrid + browserEngine "firefox": ağa HİÇ istek atmadan SeleniumGridError fırlatır', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { BrowserManager, SeleniumGridError } = await loadWithEnv({ SELENIUM_GRID_URL: HUB_URL });
    const manager = new BrowserManager();

    await expect(manager.launch({ ...baseOptions, browserEngine: 'firefox' })).rejects.toBeInstanceOf(
      SeleniumGridError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('useSeleniumGrid + browserEngine "webkit": ağa HİÇ istek atmadan SeleniumGridError fırlatır', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { BrowserManager, SeleniumGridError } = await loadWithEnv({ SELENIUM_GRID_URL: HUB_URL });
    const manager = new BrowserManager();

    await expect(manager.launch({ ...baseOptions, browserEngine: 'webkit' })).rejects.toBeInstanceOf(
      SeleniumGridError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('useSeleniumGrid + chromium ama SELENIUM_GRID_URL yapılandırılmamış: ağa HİÇ istek atmadan SeleniumGridError fırlatır', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { BrowserManager, SeleniumGridError } = await loadWithEnv({ SELENIUM_GRID_URL: undefined });
    const manager = new BrowserManager();

    await expect(manager.launch(baseOptions)).rejects.toBeInstanceOf(SeleniumGridError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('useSeleniumGrid + chromium + yapılandırılmış hub: SeleniumGridClient ile session açar, chromium.connectOverCDP\'ye bağlanır ve close() session\'ı serbest bırakır', async () => {
    vi.doMock(ENV_MODULE, () => ({ env: baseEnv({ SELENIUM_GRID_URL: HUB_URL }) }));

    const fakePage = {
      video: vi.fn().mockReturnValue(null),
      on: vi.fn(),
    };
    // v3.29 — bkz. BrowserManager.hidePreExistingGridWindows dosya başı NOT'u: KENDİ sayfamızın
    // CDP target'ını bulmak için kullanılır (bu sahte target'a "own-target-1" diyoruz).
    const ownCdpSession = {
      send: vi.fn().mockResolvedValue({ targetInfo: { targetId: 'own-target-1' } }),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const fakeContext = {
      setDefaultTimeout: vi.fn(),
      setDefaultNavigationTimeout: vi.fn(),
      tracing: { start: vi.fn(), stop: vi.fn() },
      newPage: vi.fn().mockResolvedValue(fakePage),
      newCDPSession: vi.fn().mockResolvedValue(ownCdpSession),
    };
    // Grid'in connectOverCDP() ÖNCESİNDE zaten açık olan boş "data:," penceresini simüle eder —
    // "own-target-1" (bizim sayfamız) HARİÇ, "type: page" olan her target bir "pencere" sayılır.
    const browserCdpSession = {
      send: vi.fn(async (method: string, params?: unknown) => {
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [
              { targetId: 'own-target-1', type: 'page', url: 'about:blank' },
              { targetId: 'other-target-1', type: 'page', url: 'data:,' },
            ],
          };
        }
        if (method === 'Browser.getWindowForTarget') {
          return { windowId: 42 };
        }
        return {};
      }),
      detach: vi.fn().mockResolvedValue(undefined),
    };
    const connectOverCDPMock = vi.fn().mockResolvedValue({
      newContext: vi.fn().mockResolvedValue(fakeContext),
      newBrowserCDPSession: vi.fn().mockResolvedValue(browserCdpSession),
      close: vi.fn().mockResolvedValue(undefined),
    });

    vi.doMock(PLAYWRIGHT_MODULE, async (importOriginal) => {
      const actual = (await importOriginal()) as typeof import('playwright');
      return { ...actual, chromium: { ...actual.chromium, connectOverCDP: connectOverCDPMock } };
    });

    const { BrowserManager } = await import('../src/core/browser/BrowserManager.js');
    const { SeleniumGridClient } = await import('../src/core/browser/SeleniumGridClient.js');

    const createSessionSpy = vi
      .spyOn(SeleniumGridClient.prototype, 'createSession')
      .mockResolvedValue({ sessionId: 'grid-sess-1', cdpUrl: 'ws://node-7:9222/devtools/browser/xyz' });
    const deleteSessionSpy = vi.spyOn(SeleniumGridClient.prototype, 'deleteSession').mockResolvedValue(undefined);

    const manager = new BrowserManager();
    const page = await manager.launch(baseOptions);

    expect(createSessionSpy).toHaveBeenCalledTimes(1);
    expect(connectOverCDPMock).toHaveBeenCalledWith('ws://node-7:9222/devtools/browser/xyz');
    expect(page).toBe(fakePage);

    // v3.29 — Grid'in önceden açtığı pencere (other-target-1) ekran dışına taşınmalı; KENDİ
    // sayfamızın penceresi (own-target-1) İÇİN Browser.getWindowForTarget/setWindowBounds HİÇ
    // çağrılmamalı — hiçbir target KAPATILMAMALI (bkz. dosya başı NOT'u: kapatma canlıda regresyona
    // yol açmıştı, bu yüzden BİLEREK sadece taşıma kullanılıyor).
    const windowCalls = browserCdpSession.send.mock.calls.filter(([method]) => method === 'Browser.getWindowForTarget');
    expect(windowCalls).toHaveLength(1);
    expect(windowCalls[0]?.[1]).toEqual({ targetId: 'other-target-1' });

    const boundsCalls = browserCdpSession.send.mock.calls.filter(([method]) => method === 'Browser.setWindowBounds');
    expect(boundsCalls).toHaveLength(1);
    expect(boundsCalls[0]?.[1]).toMatchObject({ windowId: 42, bounds: { left: -32000, top: -32000 } });

    await manager.close();

    expect(deleteSessionSpy).toHaveBeenCalledWith('grid-sess-1');
  });
});
