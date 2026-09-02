import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseEnv } from './helpers/fakeEnv.js';
import type { AgentDecision, RunOptions } from '../src/domain/types.js';
import type { ElementHandleRef } from '../src/core/dom/DomAnalyzer.js';

const ENV_MODULE = '../src/config/env.js';

// hepsiburada.com click-timeout regresyon koruması (bkz. InterceptingOverlayHandler dosya başı
// açıklaması): gerçek DOM/tarayıcı mantığı InterceptingOverlayHandler'ın kendi testinde (varsa)
// doğrulanır — burada sadece ActionExecutor'ın onu NE ZAMAN çağırdığını ve sonucuna göre NASIL
// davrandığını (tekrar deneme / etmeme / force:true ile deneme) test ediyoruz. Varsayılan olarak
// "denemeye değmez" ({attempted:false}) döner ki mevcut testler (TIMEOUT/ELEMENT_NOT_INTERACTABLE
// sınıflandırma testleri dahil) bu yeni davranıştan etkilenmesin — recoverMock çağrılır ama
// attempted:false döndüğü için hiçbir ek deneme yapılmaz.
const NOT_ATTEMPTED = { attempted: false, persistentBlocker: false };
const recoverMock = vi.fn().mockResolvedValue(NOT_ATTEMPTED);
vi.doMock('../src/core/browser/InterceptingOverlayHandler.js', () => ({ tryRecoverFromIntercept: recoverMock }));

// Çerez/onay banner'ı yarış durumu düzeltmesi (bkz. ActionExecutor.runInteractionWithOverlayRecovery
// dosya başı NOT): gerçek dismissConsentBanners() DOM'a bağımlıdır, burada sadece "TIMEOUT/
// ELEMENT_NOT_INTERACTABLE'da, tryRecoverFromIntercept'TEN ÖNCE çağrılıyor mu" davranışını test
// ediyoruz. Best-effort bir yardımcı olduğu için varsayılan olarak hiçbir şey yapmaz (undefined döner).
const dismissConsentBannersMock = vi.fn().mockResolvedValue(undefined);
vi.doMock('../src/core/browser/ConsentBannerHandler.js', () => ({ dismissConsentBanners: dismissConsentBannersMock }));

vi.doMock(ENV_MODULE, () => ({ env: baseEnv() }));
const { ActionExecutor } = await import('../src/core/actions/ActionExecutor.js');

afterEach(() => {
  vi.clearAllMocks();
  // mockReset (sadece clearAllMocks DEĞİL): bir testte kullanılmadan kalmış olabilecek
  // mockResolvedValueOnce() kuyruğu varsa, bunun bir SONRAKİ teste "sızmasını" önler.
  recoverMock.mockReset();
  recoverMock.mockResolvedValue(NOT_ATTEMPTED);
  dismissConsentBannersMock.mockReset();
  dismissConsentBannersMock.mockResolvedValue(undefined);
});

function fakeOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    maxSteps: 10,
    headless: true,
    stepTimeoutMs: 5000,
    navigationTimeoutMs: 5000,
    defaultActionTimeoutMs: 3000,
    maxElementsPerStep: 40,
    maxRepeatedActions: 3,
    minConfidence: 0.5,
    viewport: { width: 1024, height: 768 },
    browserEngine: 'chromium',
    captureScreenshot: false,
    captureVideo: false,
    captureTrace: false,
    useSeleniumGrid: false,
    ...overrides,
  };
}

function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return { reasoning: 'test', confidence: 0.9, action: 'click', ...overrides };
}

/** verifyValueStuck() locator.page().waitForTimeout(300) çağırdığı için page() sahtelenmeli. */
function createFakeLocator(overrides: Record<string, unknown> = {}) {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    dblclick: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    pressSequentially: vi.fn().mockResolvedValue(undefined),
    press: vi.fn().mockResolvedValue(undefined),
    selectOption: vi.fn().mockResolvedValue(undefined),
    check: vi.fn().mockResolvedValue(undefined),
    uncheck: vi.fn().mockResolvedValue(undefined),
    hover: vi.fn().mockResolvedValue(undefined),
    scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
    isVisible: vi.fn().mockResolvedValue(true),
    inputValue: vi.fn().mockResolvedValue(''),
    page: vi.fn().mockReturnValue({ waitForTimeout: vi.fn().mockResolvedValue(undefined) }),
    ...overrides,
  };
}

function createFakePage(overrides: Record<string, unknown> = {}) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockReturnValue({ innerText: vi.fn().mockResolvedValue('') }),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    url: vi.fn().mockReturnValue('https://example.com/current'),
    ...overrides,
  };
}

function registryWith(ref: string, locator: ReturnType<typeof createFakeLocator>): Map<string, ElementHandleRef> {
  const frame = { locator: vi.fn().mockReturnValue({ first: () => locator }) };
  const map = new Map<string, ElementHandleRef>();
  map.set(ref, { ref, frame: frame as never, selector: `[data-ai-ref="${ref}"]` });
  return map;
}

describe('ActionExecutor — halüsinasyon koruması (bilinmeyen ref)', () => {
  it('registry’de olmayan bir targetRef için ELEMENT_NOT_FOUND ile başarısız olur', async () => {
    const executor = new ActionExecutor();
    const page = createFakePage();

    const result = await executor.execute(
      page as never,
      decision({ action: 'click', targetRef: 'e999' }),
      undefined,
      new Map(),
      fakeOptions(),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('ELEMENT_NOT_FOUND');
  });
});

describe('ActionExecutor — temel aksiyonlar', () => {
  it('click: doğru locator’ı çözüp tıklar', async () => {
    const executor = new ActionExecutor();
    const locator = createFakeLocator();
    const registry = registryWith('e1', locator);

    const result = await executor.execute(createFakePage() as never, decision({ action: 'click', targetRef: 'e1' }), undefined, registry, fakeOptions());

    expect(result.ok).toBe(true);
    expect(locator.click).toHaveBeenCalledWith({ timeout: 3000 });
  });

  it('navigate: value eksikse INVALID_ACTION; value varsa page.goto çağrılır', async () => {
    const executor = new ActionExecutor();
    const page = createFakePage();

    const missing = await executor.execute(page as never, decision({ action: 'navigate' }), undefined, new Map(), fakeOptions());
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errorCode).toBe('INVALID_ACTION');

    const withValue = await executor.execute(page as never, decision({ action: 'navigate' }), 'https://example.com', new Map(), fakeOptions());
    expect(withValue.ok).toBe(true);
    expect(page.goto).toHaveBeenCalledWith('https://example.com', { timeout: 5000, waitUntil: 'domcontentloaded' });
  });

  it('wait: value’ü ms cinsinden bekler, geçersiz/eksik değerde 1000ms’e, aşırı büyük değerde 8000ms’e sınırlar', async () => {
    const executor = new ActionExecutor();
    const page = createFakePage();

    await executor.execute(page as never, decision({ action: 'wait' }), '500', new Map(), fakeOptions());
    expect(page.waitForTimeout).toHaveBeenNthCalledWith(1, 500);

    await executor.execute(page as never, decision({ action: 'wait' }), 'not-a-number', new Map(), fakeOptions());
    expect(page.waitForTimeout).toHaveBeenNthCalledWith(2, 1000);

    await executor.execute(page as never, decision({ action: 'wait' }), '999999', new Map(), fakeOptions());
    expect(page.waitForTimeout).toHaveBeenNthCalledWith(3, 8000);
  });

  it('assert_visible: element görünürse OK, görünmezse ASSERTION_FAILED', async () => {
    const executor = new ActionExecutor();
    const visible = createFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const hidden = createFakeLocator({ isVisible: vi.fn().mockResolvedValue(false) });

    const okResult = await executor.execute(createFakePage() as never, decision({ action: 'assert_visible', targetRef: 'e1' }), undefined, registryWith('e1', visible), fakeOptions());
    expect(okResult.ok).toBe(true);

    const failResult = await executor.execute(createFakePage() as never, decision({ action: 'assert_visible', targetRef: 'e1' }), undefined, registryWith('e1', hidden), fakeOptions());
    expect(failResult.ok).toBe(false);
    if (!failResult.ok) expect(failResult.errorCode).toBe('ASSERTION_FAILED');
  });

  it('assert_text: sayfa metninde beklenen değer varsa OK, yoksa ASSERTION_FAILED', async () => {
    const executor = new ActionExecutor();
    const page = createFakePage({
      locator: vi.fn().mockReturnValue({ innerText: vi.fn().mockResolvedValue('Hoş geldiniz, giriş başarılı!') }),
    });

    const okResult = await executor.execute(page as never, decision({ action: 'assert_text' }), 'giriş başarılı', new Map(), fakeOptions());
    expect(okResult.ok).toBe(true);

    const failResult = await executor.execute(page as never, decision({ action: 'assert_text' }), 'hiç bulunmayan metin', new Map(), fakeOptions());
    expect(failResult.ok).toBe(false);
    if (!failResult.ok) expect(failResult.errorCode).toBe('ASSERTION_FAILED');
  });

  it('assert_url: mevcut URL beklenen parçayı içeriyorsa OK, içermiyorsa ASSERTION_FAILED', async () => {
    const executor = new ActionExecutor();
    const page = createFakePage({ url: vi.fn().mockReturnValue('https://example.com/checkout/success') });

    const okResult = await executor.execute(page as never, decision({ action: 'assert_url' }), '/checkout/success', new Map(), fakeOptions());
    expect(okResult.ok).toBe(true);

    const failResult = await executor.execute(page as never, decision({ action: 'assert_url' }), '/checkout/failed', new Map(), fakeOptions());
    expect(failResult.ok).toBe(false);
  });

  it('select_option: önce label ile dener, başarısız olursa ham değerle tekrar dener', async () => {
    const executor = new ActionExecutor();
    const selectOption = vi
      .fn()
      .mockRejectedValueOnce(new Error('label eşleşmedi'))
      .mockResolvedValueOnce(undefined);
    const locator = createFakeLocator({ selectOption });

    const result = await executor.execute(createFakePage() as never, decision({ action: 'select_option', targetRef: 'e1' }), 'tr', registryWith('e1', locator), fakeOptions());

    expect(result.ok).toBe(true);
    expect(selectOption).toHaveBeenNthCalledWith(1, { label: 'tr' }, { timeout: 3000 });
    expect(selectOption).toHaveBeenNthCalledWith(2, 'tr', { timeout: 3000 });
  });

  it('finish_success/finish_failure/ask_clarification: ActionExecutor bunları uygulamaz, kontrolü AgentLoop’a bıraktığını bildirir', async () => {
    const executor = new ActionExecutor();
    const page = createFakePage();

    for (const action of ['finish_success', 'finish_failure', 'ask_clarification'] as const) {
      const result = await executor.execute(page as never, decision({ action }), undefined, new Map(), fakeOptions());
      expect(result.ok).toBe(true);
    }
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('bilinmeyen bir aksiyon türü için INVALID_ACTION döner', async () => {
    const executor = new ActionExecutor();
    const page = createFakePage();

    const result = await executor.execute(page as never, decision({ action: 'teleport' as never }), undefined, new Map(), fakeOptions());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('INVALID_ACTION');
  });
});

describe('ActionExecutor — fill/type "değer kalıcı değil" doğrulaması (hepsiburada.com regresyon koruması)', () => {
  it('fill: değer ilk denemede kalıcıysa tekrar denemeden başarılı olur', async () => {
    const executor = new ActionExecutor();
    const locator = createFakeLocator({ inputValue: vi.fn().mockResolvedValue('laptop') });

    const result = await executor.execute(createFakePage() as never, decision({ action: 'fill', targetRef: 'e1' }), 'laptop', registryWith('e1', locator), fakeOptions());

    expect(result.ok).toBe(true);
    expect(locator.fill).toHaveBeenCalledTimes(1);
    expect(locator.pressSequentially).not.toHaveBeenCalled();
  });

  it('fill: değer ilk seferde sıfırlanırsa (component swap), karakter-karakter yeniden dener ve başarılı olur', async () => {
    const executor = new ActionExecutor();
    const inputValue = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('laptop');
    const locator = createFakeLocator({ inputValue });

    const result = await executor.execute(createFakePage() as never, decision({ action: 'fill', targetRef: 'e1' }), 'laptop', registryWith('e1', locator), fakeOptions());

    expect(result.ok).toBe(true);
    expect(locator.pressSequentially).toHaveBeenCalledWith('laptop', { timeout: 3000, delay: 20 });
  });

  it('fill: değer hiçbir zaman kalıcı olmuyorsa ELEMENT_NOT_INTERACTABLE ile başarısız olur', async () => {
    const executor = new ActionExecutor();
    const locator = createFakeLocator({ inputValue: vi.fn().mockResolvedValue('') });

    const result = await executor.execute(createFakePage() as never, decision({ action: 'fill', targetRef: 'e1' }), 'laptop', registryWith('e1', locator), fakeOptions());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('ELEMENT_NOT_INTERACTABLE');
  });

  it('fill: value verilmemişse INVALID_ACTION döner', async () => {
    const executor = new ActionExecutor();
    const locator = createFakeLocator();

    const result = await executor.execute(createFakePage() as never, decision({ action: 'fill', targetRef: 'e1' }), undefined, registryWith('e1', locator), fakeOptions());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('INVALID_ACTION');
  });

  it('fill: inputValue() hata fırlatan (ör. contenteditable) elementlerde doğrulama atlanır ve OK sayılır', async () => {
    const executor = new ActionExecutor();
    const locator = createFakeLocator({ inputValue: vi.fn().mockRejectedValue(new Error('contenteditable desteklenmiyor')) });

    const result = await executor.execute(createFakePage() as never, decision({ action: 'fill', targetRef: 'e1' }), 'merhaba', registryWith('e1', locator), fakeOptions());

    expect(result.ok).toBe(true);
    expect(locator.pressSequentially).not.toHaveBeenCalled();
  });
});

describe('ActionExecutor — hata sınıflandırma (classifyError)', () => {
  it('"Timeout ... exceeded" mesajını TIMEOUT olarak sınıflandırır', async () => {
    const executor = new ActionExecutor();
    const locator = createFakeLocator({ click: vi.fn().mockRejectedValue(new Error('Timeout 3000ms exceeded.')) });

    const result = await executor.execute(createFakePage() as never, decision({ action: 'click', targetRef: 'e1' }), undefined, registryWith('e1', locator), fakeOptions());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('TIMEOUT');
  });

  it('"not visible" mesajını ELEMENT_NOT_INTERACTABLE olarak sınıflandırır', async () => {
    const executor = new ActionExecutor();
    const locator = createFakeLocator({ click: vi.fn().mockRejectedValue(new Error('element is not visible')) });

    const result = await executor.execute(createFakePage() as never, decision({ action: 'click', targetRef: 'e1' }), undefined, registryWith('e1', locator), fakeOptions());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('ELEMENT_NOT_INTERACTABLE');
  });

  it('"net::ERR_..." mesajını NAVIGATION_ERROR olarak sınıflandırır', async () => {
    const executor = new ActionExecutor();
    const page = createFakePage({ goto: vi.fn().mockRejectedValue(new Error('net::ERR_CONNECTION_REFUSED at https://example.com')) });

    const result = await executor.execute(page as never, decision({ action: 'navigate' }), 'https://example.com', new Map(), fakeOptions());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('NAVIGATION_ERROR');
  });

  it('tanınmayan bir hata mesajını UNKNOWN olarak sınıflandırır', async () => {
    const executor = new ActionExecutor();
    const locator = createFakeLocator({ click: vi.fn().mockRejectedValue(new Error('beklenmedik bir çekirdek hatası')) });

    const result = await executor.execute(createFakePage() as never, decision({ action: 'click', targetRef: 'e1' }), undefined, registryWith('e1', locator), fakeOptions());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('UNKNOWN');
  });
});

describe('ActionExecutor — engelleyici öğe kurtarma (hepsiburada.com e37 click-timeout regresyon koruması)', () => {
  it('click TIMEOUT ile başarısız olur ve kurtarma "denemeye değer" (true) derse, aksiyon BİR KEZ DAHA denenir; ikinci denemede başarılıysa OK döner', async () => {
    const executor = new ActionExecutor();
    const clickMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('Timeout 3000ms exceeded.'))
      .mockResolvedValueOnce(undefined);
    const locator = createFakeLocator({ click: clickMock });
    const page = createFakePage();
    recoverMock.mockResolvedValueOnce({ attempted: true, persistentBlocker: false });

    const result = await executor.execute(page as never, decision({ action: 'click', targetRef: 'e1' }), undefined, registryWith('e1', locator), fakeOptions());

    expect(result.ok).toBe(true);
    expect(clickMock).toHaveBeenCalledTimes(2);
    expect(recoverMock).toHaveBeenCalledTimes(1);
    expect(recoverMock).toHaveBeenCalledWith(page, locator);
  });

  it('kurtarma "denemeye değmez" (attempted:false) derse, tekrar denenmeden orijinal TIMEOUT hatası döner (sadece 1 click denemesi)', async () => {
    const executor = new ActionExecutor();
    const clickMock = vi.fn().mockRejectedValue(new Error('Timeout 3000ms exceeded.'));
    const locator = createFakeLocator({ click: clickMock });
    recoverMock.mockResolvedValueOnce(NOT_ATTEMPTED);

    const result = await executor.execute(createFakePage() as never, decision({ action: 'click', targetRef: 'e1' }), undefined, registryWith('e1', locator), fakeOptions());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('TIMEOUT');
    expect(clickMock).toHaveBeenCalledTimes(1);
    expect(recoverMock).toHaveBeenCalledTimes(1);
  });

  it('kurtarma denendi (attempted:true) ama tekrar deneme de başarısız olursa, sınıflandırılmış hata döner ve SADECE BİR ekstra deneme yapılır (sonsuz döngüye girmez)', async () => {
    const executor = new ActionExecutor();
    const clickMock = vi.fn().mockRejectedValue(new Error('Timeout 3000ms exceeded.'));
    const locator = createFakeLocator({ click: clickMock });
    recoverMock.mockResolvedValueOnce({ attempted: true, persistentBlocker: false });

    const result = await executor.execute(createFakePage() as never, decision({ action: 'click', targetRef: 'e1' }), undefined, registryWith('e1', locator), fakeOptions());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('TIMEOUT');
    expect(clickMock).toHaveBeenCalledTimes(2);
    expect(recoverMock).toHaveBeenCalledTimes(1);
  });

  it('ELEMENT_NOT_INTERACTABLE hatasında da kurtarma denemesi tetiklenir (sadece TIMEOUT\'a özel değildir)', async () => {
    const executor = new ActionExecutor();
    const clickMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('element intercepts pointer events'))
      .mockResolvedValueOnce(undefined);
    const locator = createFakeLocator({ click: clickMock });
    recoverMock.mockResolvedValueOnce({ attempted: true, persistentBlocker: false });

    const result = await executor.execute(createFakePage() as never, decision({ action: 'click', targetRef: 'e1' }), undefined, registryWith('e1', locator), fakeOptions());

    expect(result.ok).toBe(true);
    expect(recoverMock).toHaveBeenCalledTimes(1);
  });

  it('kalıcı (kapatılamayan) engelleyici regresyon koruması: persistentBlocker:true dönerse, retry force:true ile denenir (hepsiburada.com "Sepete Ekle" sticky bar regresyon koruması)', async () => {
    const executor = new ActionExecutor();
    const clickMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('Timeout 10000ms exceeded.'))
      .mockResolvedValueOnce(undefined);
    const locator = createFakeLocator({ click: clickMock });
    recoverMock.mockResolvedValueOnce({ attempted: true, persistentBlocker: true });

    const result = await executor.execute(createFakePage() as never, decision({ action: 'click', targetRef: 'e1' }), undefined, registryWith('e1', locator), fakeOptions());

    expect(result.ok).toBe(true);
    expect(clickMock).toHaveBeenNthCalledWith(1, { timeout: 3000 });
    // v3.8 SAFETY_MARGIN_MS (800ms) recoveryDeadline hesabına dahil olduğu için, testin dar
    // stepTimeoutMs'i (5000ms) altında retry bütçesi artık RETRY_TIMEOUT_CAP_MS'in (3000ms) DEĞİL,
    // gerçek kalan bütçenin altına düşüyor (~2700ms) — kasıtlı, bkz. ActionExecutor v3.8 notu.
    expect(clickMock).toHaveBeenNthCalledWith(2, { timeout: 2700, force: true });
  });

  it('kalıcı engelleyici bulunamadıysa (persistentBlocker:false), retry normal şekilde (force OLMADAN) denenir', async () => {
    const executor = new ActionExecutor();
    const clickMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('Timeout 3000ms exceeded.'))
      .mockResolvedValueOnce(undefined);
    const locator = createFakeLocator({ click: clickMock });
    recoverMock.mockResolvedValueOnce({ attempted: true, persistentBlocker: false });

    const result = await executor.execute(createFakePage() as never, decision({ action: 'click', targetRef: 'e1' }), undefined, registryWith('e1', locator), fakeOptions());

    expect(result.ok).toBe(true);
    // bkz. yukarıdaki "kalıcı (kapatılamayan) engelleyici" testindeki SAFETY_MARGIN_MS notu.
    expect(clickMock).toHaveBeenNthCalledWith(2, { timeout: 2700, force: undefined });
  });

  it('NAVIGATION_ERROR/UNKNOWN gibi engelleyici-öğe-DIŞI hatalarda kurtarma denemesi HİÇ tetiklenmez', async () => {
    const executor = new ActionExecutor();
    const clickMock = vi.fn().mockRejectedValue(new Error('beklenmedik bir çekirdek hatası'));
    const locator = createFakeLocator({ click: clickMock });

    const result = await executor.execute(createFakePage() as never, decision({ action: 'click', targetRef: 'e1' }), undefined, registryWith('e1', locator), fakeOptions());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('UNKNOWN');
    expect(recoverMock).not.toHaveBeenCalled();
    expect(dismissConsentBannersMock).not.toHaveBeenCalled();
  });

  it('çerez/onay banner’ı yarış durumu regresyon koruması: TIMEOUT/ELEMENT_NOT_INTERACTABLE hatasında dismissConsentBanners(), generic tryRecoverFromIntercept’TEN ÖNCE çağrılır; banner kapatılınca retry başarılı olur', async () => {
    const executor = new ActionExecutor();
    const clickMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('element intercepts pointer events'))
      .mockResolvedValueOnce(undefined);
    const locator = createFakeLocator({ click: clickMock });
    const page = createFakePage();
    const callOrder: string[] = [];
    dismissConsentBannersMock.mockImplementationOnce(async () => {
      callOrder.push('dismissConsentBanners');
    });
    recoverMock.mockImplementationOnce(async () => {
      callOrder.push('tryRecoverFromIntercept');
      return { attempted: true, persistentBlocker: false };
    });

    const result = await executor.execute(page as never, decision({ action: 'click', targetRef: 'e1' }), undefined, registryWith('e1', locator), fakeOptions());

    expect(result.ok).toBe(true);
    expect(dismissConsentBannersMock).toHaveBeenCalledTimes(1);
    expect(dismissConsentBannersMock).toHaveBeenCalledWith(page);
    expect(callOrder).toEqual(['dismissConsentBanners', 'tryRecoverFromIntercept']);
  });

  it('check/uncheck/dblclick/hover de AYNI kurtarma sarmalayıcısını kullanır (örnek: check)', async () => {
    const executor = new ActionExecutor();
    const checkMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('Timeout 3000ms exceeded.'))
      .mockResolvedValueOnce(undefined);
    const locator = createFakeLocator({ check: checkMock });
    recoverMock.mockResolvedValueOnce({ attempted: true, persistentBlocker: false });

    const result = await executor.execute(createFakePage() as never, decision({ action: 'check', targetRef: 'e1' }), undefined, registryWith('e1', locator), fakeOptions());

    expect(result.ok).toBe(true);
    expect(checkMock).toHaveBeenCalledTimes(2);
  });

  it('zaman aşımı bütçesi regresyon koruması: retry denemesi, defaultActionTimeoutMs büyük olsa bile ORİJİNAL süreyi DEĞİL, kısaltılmış bir üst sınırı kullanır (AgentLoop.stepTimeoutMs’i aşıp tüm run’ı loglanmamış ERROR olarak bitirmesin diye)', async () => {
    const executor = new ActionExecutor();
    const clickMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('Timeout 10000ms exceeded.'))
      .mockResolvedValueOnce(undefined);
    const locator = createFakeLocator({ click: clickMock });
    recoverMock.mockResolvedValueOnce({ attempted: true, persistentBlocker: false });

    // Gerçek run'da gözlemlenen değer: PLAYWRIGHT_DEFAULT_TIMEOUT_MS=10000ms.
    const result = await executor.execute(
      createFakePage() as never,
      decision({ action: 'click', targetRef: 'e1' }),
      undefined,
      registryWith('e1', locator),
      fakeOptions({ defaultActionTimeoutMs: 10000 }),
    );

    expect(result.ok).toBe(true);
    // İlk deneme tam süreyi kullanır (v3.8 taslağında denenip GERİ ALINAN first-attempt tavanlaması
    // bkz. ActionExecutor dosya-içi notu — bu sözleşme kasıtlı olarak korunuyor)...
    expect(clickMock).toHaveBeenNthCalledWith(1, { timeout: 10000 });
    // ...ama retry denemesi çok daha kısa, gerçek kalan bütçeyle sınırlanır (10000 DEĞİL; testin dar
    // stepTimeoutMs'i (5000ms) ve SAFETY_MARGIN_MS (800ms) nedeniyle burada ~2700ms'e iniyor).
    expect(clickMock).toHaveBeenNthCalledWith(2, { timeout: 2700 });
  });
});
