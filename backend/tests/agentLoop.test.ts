import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { baseEnv } from './helpers/fakeEnv.js';
import type { LlmProvider } from '../src/core/llm/LlmProvider.js';
import type { PageSnapshot, RunOptions } from '../src/domain/types.js';

/**
 * AgentLoop, sistemin GÜVENLİK KRİTİK orkestrasyon katmanıdır (düşük-güven durdurma, bilinmeyen
 * referans durdurma, döngü tespiti, secret maskeleme). Bu yüzden burada BrowserManager/DomAnalyzer/
 * ActionExecutor/ConsentBannerHandler TAMAMEN sahtelenir (gerçek tarayıcı asla açılmaz) — sadece
 * AgentLoop'un KENDİ karar mantığı test edilir. LoopGuard/SecretsVault/PromptBuilder/ResponseParser
 * bilerek GERÇEK bırakıldı: bu, AgentLoop'un onlarla doğru entegre olduğunu da örtük olarak doğrular.
 */

const runsDir = mkdtempSync(path.join(tmpdir(), 'agent-loop-runs-'));
afterAll(() => rmSync(runsDir, { recursive: true, force: true }));

vi.mock('../src/config/env.js', () => ({ env: baseEnv({ RUNS_DIR: runsDir }) }));

// AgentLoop yalnızca adoptNewestPageIfOpened() true dönerse getPage()'i çağırır; bu test dosyasındaki
// senaryoların hiçbiri sekme değiştirmeyi tetiklemez (adoptNewestMock her zaman false döner) — yine de
// arayüzü eksiksiz sahtelemek için `currentFakePage`'i güncel tutuyoruz.
let currentFakePage: unknown;
const launchMock = vi.fn();
const closeMock = vi.fn().mockResolvedValue({});
const adoptNewestMock = vi.fn().mockResolvedValue(false);
// v3.27 — bkz. BrowserManager.getLivePage dosya başı NOT'u ("page.isClosed()" kurtarma akışı).
// Varsayılan `null` (hiçbir kurtarma sayfası yok) — SADECE ilgili testler bunu bir sahte sayfayla
// override eder; happy-path testlerinde `page.isClosed()` hep `false` döndüğü için bu mock hiç
// çağrılmaz.
const getLivePageMock = vi.fn(() => null as unknown);

vi.mock('../src/core/browser/BrowserManager.js', () => ({
  BrowserManager: vi.fn().mockImplementation(() => ({
    launch: launchMock,
    getPage: vi.fn(() => currentFakePage),
    getLivePage: getLivePageMock,
    adoptNewestPageIfOpened: adoptNewestMock,
    // v2.2 — bkz. BrowserManager.getGridLiveViewUrl dosya başı açıklaması. Bu test dosyasındaki
    // senaryoların hiçbiri Selenium Grid kullanmıyor — bu yüzden sabit `null` yeterli (AgentLoop
    // bunu `?? undefined`'a çevirip sadece doluysa loglar/olay yayınlar).
    getGridLiveViewUrl: vi.fn().mockReturnValue(null),
    captureScreenshot: vi.fn().mockResolvedValue(false),
    stopTracing: vi.fn().mockResolvedValue(false),
    close: closeMock,
  })),
}));

vi.mock('../src/core/browser/ConsentBannerHandler.js', () => ({
  dismissConsentBanners: vi.fn().mockResolvedValue(undefined),
}));

const analyzeMock = vi.fn();
vi.mock('../src/core/dom/DomAnalyzer.js', () => ({
  DomAnalyzer: vi.fn().mockImplementation(() => ({ analyze: analyzeMock })),
}));

const executeMock = vi.fn();
vi.mock('../src/core/actions/ActionExecutor.js', () => ({
  ActionExecutor: vi.fn().mockImplementation(() => ({ execute: executeMock })),
}));

const { AgentLoop } = await import('../src/core/agent/AgentLoop.js');

function fakeOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    maxSteps: 5,
    headless: true,
    stepTimeoutMs: 5000,
    navigationTimeoutMs: 5000,
    defaultActionTimeoutMs: 5000,
    maxElementsPerStep: 20,
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

function fakeSnapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://example.com',
    title: 'Örnek Sayfa',
    elements: [{ ref: 'e1', tag: 'button', role: 'button', accessibleName: 'Gönder', text: 'Gönder', attributes: {}, visible: true, enabled: true, frame: 'main' }],
    totalDiscovered: 1,
    stateHash: 'hash-const',
    alerts: [],
    ...overrides,
  };
}

function decisionJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({ reasoning: 'test', confidence: 0.9, action: 'click', targetRef: 'e1', ...overrides });
}

/** Her çağrıda listedeki bir sonraki yanıtı döner; liste tükenirse son yanıtı tekrar eder. */
function scriptedLlm(responses: string[]): { provider: LlmProvider; completeMock: ReturnType<typeof vi.fn> } {
  let callIndex = 0;
  const completeMock = vi.fn(async () => {
    const response = responses[Math.min(callIndex, responses.length - 1)] ?? '{}';
    callIndex++;
    return response;
  });
  return {
    provider: { name: 'scripted-test-llm', complete: completeMock, validateConfig: vi.fn().mockResolvedValue(undefined) },
    completeMock,
  };
}

function setupHappyBrowserDefaults(): void {
  const fakePage = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue('https://example.com'),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    // v3.27 — bkz. AgentLoop.run döngü başındaki "page.isClosed()" kontrolü (BrowserManager.getLivePage
    // dosya başı NOT'u) — gerçek Playwright Page'lerinde HER ZAMAN var olan bir metod, testlerde de
    // olması gerekiyor; aksi halde HER adımda çağrılıp "isClosed is not a function" ile patlar.
    isClosed: vi.fn().mockReturnValue(false),
  };
  currentFakePage = fakePage;
  launchMock.mockReset().mockResolvedValue(fakePage);
  closeMock.mockReset().mockResolvedValue({});
  adoptNewestMock.mockReset().mockResolvedValue(false);
  getLivePageMock.mockReset().mockReturnValue(null);
  analyzeMock.mockReset().mockResolvedValue({ snapshot: fakeSnapshot(), registry: new Map() });
  executeMock.mockReset().mockResolvedValue({ ok: true, message: 'ok' });
}

describe('AgentLoop — terminal aksiyonlar', () => {
  it('finish_success: run "passed" ile biter, ActionExecutor hiç çağrılmaz', async () => {
    setupHappyBrowserDefaults();
    const { provider } = scriptedLlm([decisionJson({ action: 'finish_success', confidence: 0.95, summary: 'Senaryo tamamlandı', targetRef: undefined })]);
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-finish-success', url: 'https://example.com', scenario: 'test', options: fakeOptions() });

    expect(report.status).toBe('passed');
    expect(report.totalSteps).toBe(1);
    expect(executeMock).not.toHaveBeenCalled();
    // v2.0 — normal AI akışından gelen bir karar 'llm' olarak damgalanmalı (bkz. AgentDecision.decisionSource).
    expect(report.steps[0]?.decision.decisionSource).toBe('llm');
  });

  it('finish_failure: run "failed" ile biter, failureReason özet metnini içerir', async () => {
    setupHappyBrowserDefaults();
    const { provider } = scriptedLlm([decisionJson({ action: 'finish_failure', confidence: 0.9, summary: 'Element hiç bulunamadı', targetRef: undefined })]);
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-finish-fail', url: 'https://example.com', scenario: 'test', options: fakeOptions() });

    expect(report.status).toBe('failed');
    expect(report.failureReason).toBe('Element hiç bulunamadı');
  });
});

describe('AgentLoop — güvenlik kapıları', () => {
  it('düşük güven (confidence < minConfidence) niyetli, terminal olmayan bir aksiyonu GÜVENLİ ŞEKİLDE durdurur', async () => {
    setupHappyBrowserDefaults();
    const { provider } = scriptedLlm([decisionJson({ action: 'click', confidence: 0.1 })]);
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-low-confidence', url: 'https://example.com', scenario: 'test', options: fakeOptions() });

    expect(report.status).toBe('failed');
    expect(report.failureReason).toContain('ambiguous_step');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('bilinmeyen bir secret/variable referansı içeren değeri ASLA çalıştırmaz, güvenli şekilde durur', async () => {
    setupHappyBrowserDefaults();
    const { provider } = scriptedLlm([decisionJson({ action: 'fill', value: '{{secret.UNKNOWN}}', confidence: 0.9 })]);
    const loop = new AgentLoop(provider);

    // input.secrets HİÇ verilmiyor -> "UNKNOWN" adında bir secret tanımsız.
    const report = await loop.run({ runId: 'r-unknown-ref', url: 'https://example.com', scenario: 'test', options: fakeOptions() });

    expect(report.status).toBe('failed');
    expect(report.failureReason).toContain('unknown_reference');
    expect(report.failureReason).toContain('secret.UNKNOWN');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('aynı aksiyon sayfa durumu değişmeden N kez tekrar edilirse döngü tespit edilip run güvenli şekilde durdurulur', async () => {
    setupHappyBrowserDefaults();
    // stateHash HER ZAMAN aynı (sayfa hiç değişmiyor) — LoopGuard bunu "takılma" olarak görmeli.
    analyzeMock.mockResolvedValue({ snapshot: fakeSnapshot({ stateHash: 'hash-sabit' }), registry: new Map() });
    const { provider } = scriptedLlm([decisionJson({ action: 'click', targetRef: 'e1', confidence: 0.9 })]);
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-loop', url: 'https://example.com', scenario: 'test', options: fakeOptions({ maxRepeatedActions: 3, maxSteps: 10 }) });

    expect(report.status).toBe('failed');
    expect(report.failureReason).toContain('loop_detected');
    // maxRepeatedActions=3 -> 3. denemede durur, daha fazla adım atmaz.
    expect(report.totalSteps).toBe(3);
  });

  it('Stop (cancel()) LLM çağrısı SÜRERKEN tetiklenirse, aksiyon HİÇ çalıştırılmadan run "cancelled" ile güvenli şekilde durur (Stop butonu "durdu diyor ama çalışmaya devam ediyor" regresyon koruması)', async () => {
    setupHappyBrowserDefaults();
    // `cancelled` bayrağı SADECE adım döngüsünün başında değil, LLM kararı alındıktan HEMEN
    // SONRA (aksiyon hiç çalıştırılmadan ÖNCE) da kontrol edilmeli — burada Stop butonuna TAM
    // OLARAK LLM çağrısı sürerken basıldığını simüle ediyoruz.
    let loop: InstanceType<typeof AgentLoop>;
    const completeMock = vi.fn(async () => {
      loop.cancel();
      return decisionJson({ action: 'click', targetRef: 'e1', confidence: 0.9 });
    });
    const provider: LlmProvider = {
      name: 'scripted-test-llm',
      complete: completeMock,
      validateConfig: vi.fn().mockResolvedValue(undefined),
    };
    loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-cancel-mid-step', url: 'https://example.com', scenario: 'test', options: fakeOptions() });

    expect(report.status).toBe('cancelled');
    expect(report.failureReason).toContain('iptal edildi');
    // KRİTİK: aksiyon (potansiyel olarak yavaş bir tarayıcı işlemi) HİÇ çalıştırılmamalı —
    // Stop butonu regresyonunda bu adım yine de çalıştırılıyordu.
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('LLM sürekli geçersiz JSON döndürürse (tüm yeniden denemeler tükenirse) run "error" ile biter', async () => {
    setupHappyBrowserDefaults();
    const { provider, completeMock } = scriptedLlm(['bu geçerli bir JSON değil']);
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-invalid-json', url: 'https://example.com', scenario: 'test', options: fakeOptions() });

    expect(report.status).toBe('error');
    expect(report.failureReason).toContain('LLM geçerli bir karar üretemedi');
    // 1 ilk deneme + 2 yeniden deneme (MAX_LLM_RETRIES_PER_STEP) = 3 LLM çağrısı.
    expect(completeMock).toHaveBeenCalledTimes(3);
  });

  it('azami adım sayısına ulaşılırsa (sonsuz döngüye girmeden) run "failed" ile ve max_steps_reached nedeniyle biter', async () => {
    setupHappyBrowserDefaults();
    let stepCounter = 0;
    // Her adımda FARKLI bir stateHash döndürerek LoopGuard'ı tetiklemeden azami adıma ulaşılmasını sağlıyoruz.
    analyzeMock.mockImplementation(async () => {
      stepCounter++;
      return { snapshot: fakeSnapshot({ stateHash: `hash-${stepCounter}` }), registry: new Map() };
    });
    const { provider } = scriptedLlm([decisionJson({ action: 'click', targetRef: 'e1', confidence: 0.9 })]);
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-max-steps', url: 'https://example.com', scenario: 'test', options: fakeOptions({ maxSteps: 2 }) });

    expect(report.status).toBe('failed');
    expect(report.failureReason).toBe('max_steps_reached: azami adım sayısına ulaşıldı');
    expect(report.totalSteps).toBe(2);
  });
});

describe('AgentLoop — sayfa kapanma kurtarma (v3.27 — ör. bir OTP/2FA popup\'ının kendi kendini kapatması)', () => {
  it('adım başında page.isClosed() true dönerse VE BrowserManager.getLivePage() başka açık bir sayfa bulursa, run o sayfayla SORUNSUZCA devam eder', async () => {
    setupHappyBrowserDefaults();
    const closedPage = currentFakePage as { isClosed: ReturnType<typeof vi.fn> };
    closedPage.isClosed.mockReturnValue(true);

    const recoveredPage = { isClosed: vi.fn().mockReturnValue(false) };
    getLivePageMock.mockReturnValue(recoveredPage);

    const { provider } = scriptedLlm([decisionJson({ action: 'finish_success', confidence: 0.95, summary: 'Kurtarılan sayfada tamamlandı', targetRef: undefined })]);
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-page-recovered', url: 'https://example.com', scenario: 'test', options: fakeOptions() });

    expect(getLivePageMock).toHaveBeenCalledTimes(1);
    expect(report.status).toBe('passed');
  });

  it('adım başında page.isClosed() true dönerse VE BrowserManager.getLivePage() hiçbir açık sayfa bulamazsa (null), run opak bir Playwright hatası yerine NET bir "browser_error:" mesajıyla "error" olarak biter', async () => {
    setupHappyBrowserDefaults();
    const closedPage = currentFakePage as { isClosed: ReturnType<typeof vi.fn> };
    closedPage.isClosed.mockReturnValue(true);
    getLivePageMock.mockReturnValue(null);

    const { provider, completeMock } = scriptedLlm([decisionJson({ action: 'click', targetRef: 'e1', confidence: 0.9 })]);
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-page-unrecoverable', url: 'https://example.com', scenario: 'test', options: fakeOptions() });

    expect(report.status).toBe('error');
    expect(report.failureReason).toContain('browser_error:');
    // Sayfa zaten kapalıyken hiç DOM taraması/LLM çağrısı yapılmamalı — hata ERKEN yakalanmalı.
    expect(analyzeMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
  });
});

describe('AgentLoop — Enter tuşu sonrası yerleşme payı (hepsiburada.com "arama sonucu gelmeden tekrar Enter" regresyon koruması)', () => {
  it('press_key Enter sonrası, URL HENÜZ değişmemiş olsa bile kısa bir yerleşme payı (800ms) verilir', async () => {
    setupHappyBrowserDefaults();
    const { provider } = scriptedLlm([
      decisionJson({ action: 'press_key', targetRef: 'e1', value: 'Enter', confidence: 0.9 }),
      decisionJson({ action: 'finish_success', confidence: 0.95, summary: 'Arama yapıldı', targetRef: undefined }),
    ]);
    const loop = new AgentLoop(provider);

    await loop.run({ runId: 'r-enter-settle', url: 'https://example.com', scenario: 'test', options: fakeOptions({ maxSteps: 5 }) });

    expect((currentFakePage as { waitForTimeout: ReturnType<typeof vi.fn> }).waitForTimeout).toHaveBeenCalledWith(800);
  });

  it('press_key Enter DIŞINDAKİ bir tuşta (ör. Tab) 800ms’lik yerleşme payı verilmez', async () => {
    setupHappyBrowserDefaults();
    const { provider } = scriptedLlm([
      decisionJson({ action: 'press_key', targetRef: 'e1', value: 'Tab', confidence: 0.9 }),
      decisionJson({ action: 'finish_success', confidence: 0.95, summary: 'Tamam', targetRef: undefined }),
    ]);
    const loop = new AgentLoop(provider);

    await loop.run({ runId: 'r-tab-no-settle', url: 'https://example.com', scenario: 'test', options: fakeOptions({ maxSteps: 5 }) });

    expect((currentFakePage as { waitForTimeout: ReturnType<typeof vi.fn> }).waitForTimeout).not.toHaveBeenCalledWith(800);
  });

  it('Enter navigasyona yol açıp URL DEĞİŞTİYSE, SADECE navigasyon yerleşme payı (500ms) kullanılır — 800ms AYRICA eklenmez', async () => {
    setupHappyBrowserDefaults();
    (currentFakePage as { url: ReturnType<typeof vi.fn> }).url = vi.fn().mockReturnValue('https://example.com/search?q=x');
    const { provider } = scriptedLlm([
      decisionJson({ action: 'press_key', targetRef: 'e1', value: 'Enter', confidence: 0.9 }),
      decisionJson({ action: 'finish_success', confidence: 0.95, summary: 'Arama yapıldı', targetRef: undefined }),
    ]);
    const loop = new AgentLoop(provider);

    await loop.run({ runId: 'r-enter-nav-settle', url: 'https://example.com', scenario: 'test', options: fakeOptions({ maxSteps: 5 }) });

    expect((currentFakePage as { waitForTimeout: ReturnType<typeof vi.fn> }).waitForTimeout).toHaveBeenCalledWith(500);
    expect((currentFakePage as { waitForTimeout: ReturnType<typeof vi.fn> }).waitForTimeout).not.toHaveBeenCalledWith(800);
  });
});

describe('AgentLoop — replaySteps toplama (AI modu, "Replay (No AI)" için hazırlık)', () => {
  it('run PASSED ile biterse, adımlar (terminal karar dahil) hedef element kimliğiyle birlikte replaySteps olarak rapora eklenir', async () => {
    setupHappyBrowserDefaults();
    const { provider } = scriptedLlm([
      decisionJson({ action: 'click', targetRef: 'e1', confidence: 0.9 }),
      decisionJson({ action: 'finish_success', confidence: 0.95, summary: 'Tamamlandı', targetRef: undefined }),
    ]);
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-replay-collect', url: 'https://example.com', scenario: 'test', options: fakeOptions({ maxSteps: 5 }) });

    expect(report.status).toBe('passed');
    expect(report.replaySteps).toHaveLength(2);
    expect(report.replaySteps?.[0]).toMatchObject({
      action: 'click',
      targetRef: 'e1',
      targetElementSnapshot: { tag: 'button', role: 'button', accessibleName: 'Gönder' },
    });
    expect(report.replaySteps?.[1]).toMatchObject({ action: 'finish_success' });
  });

  it('run FAILED ile biterse replaySteps rapora HİÇ eklenmez (adapte olabilecek bir AI olmadan başarısız bir senaryoyu tekrar oynatmak anlamsızdır)', async () => {
    setupHappyBrowserDefaults();
    const { provider } = scriptedLlm([decisionJson({ action: 'click', confidence: 0.1 })]);
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-replay-no-collect-on-fail', url: 'https://example.com', scenario: 'test', options: fakeOptions() });

    expect(report.status).toBe('failed');
    expect(report.replaySteps).toBeUndefined();
  });
});

describe('AgentLoop — Replay (No AI) modu', () => {
  it('replaySteps verilirse LLM\'e HİÇ danışılmaz (complete/validateConfig hiç çağrılmaz, llmCallCount=0) ve kayıtlı adımlar aynen uygulanır', async () => {
    setupHappyBrowserDefaults();
    const completeMock = vi.fn();
    const validateConfigMock = vi.fn().mockResolvedValue(undefined);
    const provider: LlmProvider = { name: 'unused-in-replay', complete: completeMock, validateConfig: validateConfigMock };
    const loop = new AgentLoop(provider);

    const report = await loop.run({
      runId: 'r-replay-happy',
      url: 'https://example.com',
      scenario: 'test',
      options: fakeOptions({ maxSteps: 5 }),
      replaySteps: [
        { action: 'click', targetRef: 'e1', targetElementSnapshot: { tag: 'button', role: 'button', accessibleName: 'Gönder' } },
        { action: 'finish_success' },
      ],
    });

    expect(report.status).toBe('passed');
    expect(report.llmCallCount).toBe(0);
    expect(completeMock).not.toHaveBeenCalled();
    expect(validateConfigMock).not.toHaveBeenCalled();
    expect(executeMock).toHaveBeenCalledTimes(1);
    // v2.0 — replay'den gelen bir karar 'replay' olarak damgalanmalı (bkz. AgentDecision.decisionSource).
    expect(report.steps[0]?.decision.decisionSource).toBe('replay');
  });

  it('kayıtlı hedef elementin kimliği (tag/role/accessibleName) o anki sayfadakiyle UYUŞMUYORSA, aksiyonu hiç denemeden güvenli şekilde durur ("replay_mismatch")', async () => {
    setupHappyBrowserDefaults();
    const provider: LlmProvider = { name: 'unused-in-replay', complete: vi.fn(), validateConfig: vi.fn() };
    const loop = new AgentLoop(provider);

    const report = await loop.run({
      runId: 'r-replay-mismatch',
      url: 'https://example.com',
      scenario: 'test',
      options: fakeOptions({ maxSteps: 5 }),
      replaySteps: [
        // fakeSnapshot()'taki e1'in gerçek accessibleName'i "Gönder" — burada BİLEREK farklı bir
        // isim kaydedilmiş gibi davranıyoruz (sayfa değişmiş senaryosu).
        { action: 'click', targetRef: 'e1', targetElementSnapshot: { tag: 'button', role: 'button', accessibleName: 'Farklı Buton' } },
        { action: 'finish_success' },
      ],
    });

    expect(report.status).toBe('failed');
    expect(report.failureReason).toContain('replay_mismatch');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('bir replay adımı ActionExecutor tarafından başarısız işaretlenirse, kalan adımları denemeden HEMEN durur ("replay_step_failed")', async () => {
    setupHappyBrowserDefaults();
    executeMock.mockReset().mockResolvedValue({ ok: false, message: 'Element bulunamadı', errorCode: 'ELEMENT_NOT_FOUND' });
    const provider: LlmProvider = { name: 'unused-in-replay', complete: vi.fn(), validateConfig: vi.fn() };
    const loop = new AgentLoop(provider);

    const report = await loop.run({
      runId: 'r-replay-action-fail',
      url: 'https://example.com',
      scenario: 'test',
      options: fakeOptions({ maxSteps: 5 }),
      replaySteps: [
        { action: 'click', targetRef: 'e1', targetElementSnapshot: { tag: 'button', role: 'button', accessibleName: 'Gönder' } },
        { action: 'click', targetRef: 'e1', targetElementSnapshot: { tag: 'button', role: 'button', accessibleName: 'Gönder' } },
        { action: 'finish_success' },
      ],
    });

    expect(report.status).toBe('failed');
    expect(report.failureReason).toContain('replay_step_failed');
    // İlk adımda başarısız oldu, İKİNCİ click adımı HİÇ denenmemeli.
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('replay modunda da bilinmeyen bir secret/variable referansı ASLA çalıştırılmaz (güvenlik kapısı 2 replay\'de de geçerlidir)', async () => {
    setupHappyBrowserDefaults();
    const provider: LlmProvider = { name: 'unused-in-replay', complete: vi.fn(), validateConfig: vi.fn() };
    const loop = new AgentLoop(provider);

    const report = await loop.run({
      runId: 'r-replay-unknown-ref',
      url: 'https://example.com',
      scenario: 'test',
      options: fakeOptions({ maxSteps: 5 }),
      // secrets HİÇ verilmiyor -> PASSWORD tanımsız.
      replaySteps: [
        { action: 'fill', targetRef: 'e1', value: '{{secret.PASSWORD}}', targetElementSnapshot: { tag: 'button', role: 'button', accessibleName: 'Gönder' } },
        { action: 'finish_success' },
      ],
    });

    expect(report.status).toBe('failed');
    expect(report.failureReason).toContain('unknown_reference');
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('AgentLoop — secret güvenliği (uçtan uca)', () => {
  it('ActionExecutor’a ÇÖZÜLMÜŞ gerçek secret değeri gider, ama nihai rapor SADECE maskelenmiş ("***") değeri içerir — gerçek değer raporda hiçbir yerde bulunmaz', async () => {
    setupHappyBrowserDefaults();
    const REAL_SECRET = 'GerçekGizliDeğer1!';
    const { provider } = scriptedLlm([
      decisionJson({ action: 'fill', targetRef: 'e1', value: '{{secret.PASSWORD}}', confidence: 0.9 }),
      decisionJson({ action: 'finish_success', confidence: 0.95, summary: 'Giriş yapıldı', targetRef: undefined }),
    ]);
    const loop = new AgentLoop(provider);

    const report = await loop.run({
      runId: 'r-secret-safety',
      url: 'https://example.com',
      scenario: 'Giriş yap',
      secrets: { PASSWORD: REAL_SECRET },
      options: fakeOptions({ maxSteps: 5 }),
    });

    expect(report.status).toBe('passed');
    // ActionExecutor'a giden değer GERÇEK (çözülmüş) değer olmalı — aksi halde Playwright'a
    // placeholder metni "{{secret.PASSWORD}}" gönderilmiş olurdu, ki bu YANLIŞ olurdu.
    expect(executeMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), REAL_SECRET, expect.anything(), expect.anything());

    // KRİTİK GÜVENLİK DOĞRULAMASI: nihai rapor JSON'ının HİÇBİR YERİNDE gerçek secret değeri olamaz.
    const serializedReport = JSON.stringify(report);
    expect(serializedReport).not.toContain(REAL_SECRET);
    expect(report.steps[0]?.maskedValue).toBe('***');
  });
});
