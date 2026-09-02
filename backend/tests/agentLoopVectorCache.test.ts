import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseEnv } from './helpers/fakeEnv.js';
import type { LlmProvider } from '../src/core/llm/LlmProvider.js';
import type { PageSnapshot, RunOptions } from '../src/domain/types.js';

/**
 * agentLoop.test.ts'ten AYRI bir dosya (bkz. browserManagerSeleniumGrid.test.ts ile aynı desen):
 * agentLoop.test.ts modül düzeyinde TEK bir sabit env mock'u kullanır (VECTOR_CACHE_ENABLED
 * orada hiç set edilmez, yani false) — bu dosya ise VECTOR_CACHE_ENABLED=true olan bir env ile
 * AgentLoop'u AYRI AYRI (her testte resetModules+remock+dinamik import) yükler.
 */
const ENV_MODULE = '../src/config/env.js';
const BROWSER_MANAGER_MODULE = '../src/core/browser/BrowserManager.js';
const CONSENT_MODULE = '../src/core/browser/ConsentBannerHandler.js';
const DOM_ANALYZER_MODULE = '../src/core/dom/DomAnalyzer.js';
const ACTION_EXECUTOR_MODULE = '../src/core/actions/ActionExecutor.js';
const VECTOR_CACHE_STORE_MODULE = '../src/core/vectorcache/VectorCacheStore.js';

afterEach(() => {
  vi.doUnmock(ENV_MODULE);
  vi.doUnmock(BROWSER_MANAGER_MODULE);
  vi.doUnmock(CONSENT_MODULE);
  vi.doUnmock(DOM_ANALYZER_MODULE);
  vi.doUnmock(ACTION_EXECUTOR_MODULE);
  vi.doUnmock(VECTOR_CACHE_STORE_MODULE);
  vi.resetModules();
});

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
    title: 'Ornek Sayfa',
    elements: [
      { ref: 'e1', tag: 'button', role: 'button', accessibleName: 'Gonder', text: 'Gonder', attributes: {}, visible: true, enabled: true, frame: 'main' },
    ],
    totalDiscovered: 1,
    stateHash: 'hash-const',
    alerts: [],
    ...overrides,
  };
}

function decisionJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({ reasoning: 'test', confidence: 0.9, action: 'click', targetRef: 'e1', ...overrides });
}

function scriptedLlm(responses: string[]): { provider: LlmProvider } {
  let callIndex = 0;
  const completeMock = vi.fn(async () => {
    const response = responses[Math.min(callIndex, responses.length - 1)] ?? '{}';
    callIndex++;
    return response;
  });
  return {
    provider: { name: 'scripted-test-llm', complete: completeMock, validateConfig: vi.fn().mockResolvedValue(undefined) },
  };
}

async function loadAgentLoopWithVectorCache(envOverrides: Record<string, unknown> = {}) {
  vi.doMock(ENV_MODULE, () => ({
    env: baseEnv({ VECTOR_CACHE_ENABLED: true, OLLAMA_EMBEDDING_MODEL: 'test-model', ...envOverrides }),
  }));

  const fakePage = {
    goto: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockReturnValue('https://example.com'),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  };
  vi.doMock(BROWSER_MANAGER_MODULE, () => ({
    BrowserManager: vi.fn().mockImplementation(() => ({
      launch: vi.fn().mockResolvedValue(fakePage),
      getPage: vi.fn(() => fakePage),
      adoptNewestPageIfOpened: vi.fn().mockResolvedValue(false),
      // v2.2 — bkz. BrowserManager.getGridLiveViewUrl dosya başı açıklaması. Bu test dosyasındaki
      // senaryoların hiçbiri Selenium Grid kullanmıyor — sabit `null` yeterli.
      getGridLiveViewUrl: vi.fn().mockReturnValue(null),
      captureScreenshot: vi.fn().mockResolvedValue(false),
      stopTracing: vi.fn().mockResolvedValue(false),
      close: vi.fn().mockResolvedValue({}),
    })),
  }));
  vi.doMock(CONSENT_MODULE, () => ({ dismissConsentBanners: vi.fn().mockResolvedValue(undefined) }));

  const analyzeMock = vi.fn().mockResolvedValue({ snapshot: fakeSnapshot(), registry: new Map() });
  vi.doMock(DOM_ANALYZER_MODULE, () => ({ DomAnalyzer: vi.fn().mockImplementation(() => ({ analyze: analyzeMock })) }));

  const executeMock = vi.fn().mockResolvedValue({ ok: true, message: 'ok' });
  vi.doMock(ACTION_EXECUTOR_MODULE, () => ({ ActionExecutor: vi.fn().mockImplementation(() => ({ execute: executeMock })) }));

  const recordDecisionMock = vi.fn().mockResolvedValue(undefined);
  const findSimilarMock = vi.fn().mockResolvedValue([]);
  vi.doMock(VECTOR_CACHE_STORE_MODULE, () => ({
    VectorCacheStore: vi.fn().mockImplementation(() => ({ recordDecision: recordDecisionMock, findSimilar: findSimilarMock })),
  }));

  const { AgentLoop } = await import('../src/core/agent/AgentLoop.js');
  return { AgentLoop, analyzeMock, executeMock, recordDecisionMock, findSimilarMock };
}

function fakeCandidate(overrides: Record<string, unknown> = {}) {
  return {
    action: 'click',
    targetTag: 'button',
    targetRole: 'button',
    targetAccessibleName: 'Gonder',
    value: undefined,
    domain: 'example.com',
    sourceRunId: 'run-source',
    similarity: 0.99,
    ...overrides,
  };
}

describe('AgentLoop — vector cache yazma tarafi (v2.0 Faz 1)', () => {
  it("AI modunda, hedefi olan basarili bir karar sonrasi vector cache'e (fire-and-forget) yazilir", async () => {
    const { AgentLoop, recordDecisionMock } = await loadAgentLoopWithVectorCache();
    const { provider } = scriptedLlm([
      decisionJson({ action: 'click', targetRef: 'e1', confidence: 0.9 }),
      decisionJson({ action: 'finish_success', confidence: 0.95, summary: 'Tamamlandi', targetRef: undefined }),
    ]);
    const loop = new AgentLoop(provider);

    const report = await loop.run({
      runId: 'r-cache-write',
      url: 'https://example.com',
      scenario: 'test senaryosu',
      options: fakeOptions({ maxSteps: 5 }),
    });

    expect(report.status).toBe('passed');
    expect(recordDecisionMock).toHaveBeenCalledTimes(1);

    const [situation, metadata] = recordDecisionMock.mock.calls[0] as [
      { scenario: string; stepIndex: number },
      Record<string, unknown>,
    ];
    expect(situation.scenario).toBe('test senaryosu');
    expect(situation.stepIndex).toBe(0);
    expect(metadata).toMatchObject({
      action: 'click',
      targetTag: 'button',
      targetRole: 'button',
      targetAccessibleName: 'Gonder',
      domain: 'example.com',
      sourceRunId: 'r-cache-write',
    });
  });

  it('hedefi olmayan (targetRef yok) bir karar icin cagrilmaz', async () => {
    const { AgentLoop, recordDecisionMock } = await loadAgentLoopWithVectorCache();
    const { provider } = scriptedLlm([
      decisionJson({ action: 'wait', value: '100', confidence: 0.9, targetRef: undefined }),
      decisionJson({ action: 'finish_success', confidence: 0.95, summary: 'Tamam', targetRef: undefined }),
    ]);
    const loop = new AgentLoop(provider);

    await loop.run({ runId: 'r-cache-no-target', url: 'https://example.com', scenario: 'test', options: fakeOptions({ maxSteps: 5 }) });

    expect(recordDecisionMock).not.toHaveBeenCalled();
  });

  it('basarisiz bir aksiyon icin cagrilmaz', async () => {
    const { AgentLoop, executeMock, recordDecisionMock } = await loadAgentLoopWithVectorCache();
    executeMock.mockResolvedValue({ ok: false, message: 'hata', errorCode: 'ELEMENT_NOT_FOUND' });
    const { provider } = scriptedLlm([decisionJson({ action: 'click', targetRef: 'e1', confidence: 0.9 })]);
    const loop = new AgentLoop(provider);

    await loop.run({ runId: 'r-cache-action-fail', url: 'https://example.com', scenario: 'test', options: fakeOptions({ maxSteps: 5 }) });

    expect(recordDecisionMock).not.toHaveBeenCalled();
  });

  it('replay modunda hic cagrilmaz (ogrenecek yeni bir sey yok)', async () => {
    const { AgentLoop, recordDecisionMock } = await loadAgentLoopWithVectorCache();
    const provider: LlmProvider = { name: 'unused-in-replay', complete: vi.fn(), validateConfig: vi.fn() };
    const loop = new AgentLoop(provider);

    await loop.run({
      runId: 'r-cache-replay',
      url: 'https://example.com',
      scenario: 'test',
      options: fakeOptions({ maxSteps: 5 }),
      replaySteps: [
        { action: 'click', targetRef: 'e1', targetElementSnapshot: { tag: 'button', role: 'button', accessibleName: 'Gonder' } },
        { action: 'finish_success' },
      ],
    });

    expect(recordDecisionMock).not.toHaveBeenCalled();
  });

  it('vector cache yazma hatasi run sonucunu ETKILEMEZ (best-effort)', async () => {
    const { AgentLoop, recordDecisionMock } = await loadAgentLoopWithVectorCache();
    recordDecisionMock.mockRejectedValue(new Error('milvus erisilemez durumda'));
    const { provider } = scriptedLlm([
      decisionJson({ action: 'click', targetRef: 'e1', confidence: 0.9 }),
      decisionJson({ action: 'finish_success', confidence: 0.95, summary: 'Tamamlandi', targetRef: undefined }),
    ]);
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-cache-write-fail', url: 'https://example.com', scenario: 'test', options: fakeOptions({ maxSteps: 5 }) });

    expect(report.status).toBe('passed');
  });

  it('VECTOR_CACHE_ENABLED=false iken VectorCacheStore hic olusturulmaz', async () => {
    const vectorCacheStoreCtorMock = vi.fn().mockImplementation(() => ({ recordDecision: vi.fn() }));

    vi.doMock(ENV_MODULE, () => ({ env: baseEnv({ VECTOR_CACHE_ENABLED: false }) }));
    vi.doMock(VECTOR_CACHE_STORE_MODULE, () => ({ VectorCacheStore: vectorCacheStoreCtorMock }));
    vi.doMock(BROWSER_MANAGER_MODULE, () => ({ BrowserManager: vi.fn() }));
    vi.doMock(CONSENT_MODULE, () => ({ dismissConsentBanners: vi.fn() }));
    vi.doMock(DOM_ANALYZER_MODULE, () => ({ DomAnalyzer: vi.fn() }));
    vi.doMock(ACTION_EXECUTOR_MODULE, () => ({ ActionExecutor: vi.fn() }));

    // AgentLoop'u import etmek, vectorCacheInstance.ts'in modul-duzeyi kodunu da tetikler — burada
    // sadece bunun VectorCacheStore constructor'ini HIC cagirmadigini dogruluyoruz (loop.run()
    // cagirmaya bile gerek yok).
    await import('../src/core/agent/AgentLoop.js');

    expect(vectorCacheStoreCtorMock).not.toHaveBeenCalled();
  });
});

describe('AgentLoop — vector cache okuma tarafi (v2.0 Faz 2)', () => {
  it('VECTOR_CACHE_READ_ENABLED=false (varsayilan) iken findSimilar hic cagrilmaz, LLM kullanilir', async () => {
    const { AgentLoop, findSimilarMock } = await loadAgentLoopWithVectorCache({ VECTOR_CACHE_READ_ENABLED: false });
    const { provider } = scriptedLlm([
      decisionJson({ action: 'click', targetRef: 'e1', confidence: 0.9 }),
      decisionJson({ action: 'finish_success', confidence: 0.95, summary: 'Tamamlandi', targetRef: undefined }),
    ]);
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-read-disabled', url: 'https://example.com', scenario: 'test', options: fakeOptions({ maxSteps: 5 }) });

    expect(report.status).toBe('passed');
    expect(report.llmCallCount).toBeGreaterThan(0);
    expect(findSimilarMock).not.toHaveBeenCalled();
  });

  it('yeterince benzer + guvenli aksiyon + eslesen element varsa LLM cagrilmadan cache karari kullanilir', async () => {
    const { AgentLoop, findSimilarMock } = await loadAgentLoopWithVectorCache({
      VECTOR_CACHE_READ_ENABLED: true,
      VECTOR_CACHE_MIN_SIMILARITY: 0.9,
    });
    // NOT: SADECE bir kez (mockResolvedValueOnce) — 1. adım cache'ten gelsin, ama 2. adımda
    // findSimilar TEKRAR aynı click/e1 adayını dönerse LoopGuard bunu (aynı aksiyon + değişmeyen
    // stateHash) bir DÖNGÜ olarak algılayıp run'ı haklı olarak durdurur. Testin amacı "cache 1
    // kez kullanılır, ardından normal akışa (LLM) devam edilir" olduğu için 2. çağrıdan itibaren
    // boş sonuç dönmesi gerekir.
    findSimilarMock.mockResolvedValueOnce([fakeCandidate({ similarity: 0.99 })]).mockResolvedValue([]);
    const completeMock = vi.fn().mockResolvedValue(decisionJson({ action: 'finish_success', confidence: 0.95, summary: 'x', targetRef: undefined }));
    const provider: LlmProvider = { name: 'unused-if-cache-hits', complete: completeMock, validateConfig: vi.fn().mockResolvedValue(undefined) };
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-cache-hit', url: 'https://example.com', scenario: 'test', options: fakeOptions({ maxSteps: 5 }) });

    expect(report.status).toBe('passed');
    // 1. adim cache'ten geldi (LLM'e HIC danisilmadi), 2. adim (finish_success) icin 1 kez cagrildi.
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(report.llmCallCount).toBe(1);
    expect(report.steps[0]?.decision.reasoning).toContain('Vector cache');
    // v2.0 — cache'ten gelen karar 'vector_cache' olarak damgalanmali (bkz. AgentDecision.decisionSource).
    expect(report.steps[0]?.decision.decisionSource).toBe('vector_cache');
  });

  it('benzerlik esigin altindaysa cache kullanilmaz, LLMe danisilir', async () => {
    const { AgentLoop, findSimilarMock } = await loadAgentLoopWithVectorCache({
      VECTOR_CACHE_READ_ENABLED: true,
      VECTOR_CACHE_MIN_SIMILARITY: 0.95,
    });
    findSimilarMock.mockResolvedValue([fakeCandidate({ similarity: 0.5 })]);
    const { provider, } = scriptedLlm([
      decisionJson({ action: 'click', targetRef: 'e1', confidence: 0.9 }),
      decisionJson({ action: 'finish_success', confidence: 0.95, summary: 'x', targetRef: undefined }),
    ]);
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-cache-low-sim', url: 'https://example.com', scenario: 'test', options: fakeOptions({ maxSteps: 5 }) });

    expect(report.status).toBe('passed');
    expect(report.llmCallCount).toBe(2);
  });

  it("veri tasiyan bir aksiyon (fill) icin, benzerlik yuksek olsa bile cache KULLANILMAZ", async () => {
    const { AgentLoop, findSimilarMock } = await loadAgentLoopWithVectorCache({ VECTOR_CACHE_READ_ENABLED: true });
    findSimilarMock.mockResolvedValue([fakeCandidate({ action: 'fill', value: 'eski-arama-terimi', similarity: 0.999 })]);
    const { provider } = scriptedLlm([
      decisionJson({ action: 'click', targetRef: 'e1', confidence: 0.9 }),
      decisionJson({ action: 'finish_success', confidence: 0.95, summary: 'x', targetRef: undefined }),
    ]);
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-cache-fill-unsafe', url: 'https://example.com', scenario: 'test', options: fakeOptions({ maxSteps: 5 }) });

    expect(report.status).toBe('passed');
    expect(report.llmCallCount).toBe(2);
  });

  it('guncel sayfada eslesen bir element yoksa (yapisal kimlik uyusmuyor) cache KULLANILMAZ', async () => {
    const { AgentLoop, findSimilarMock } = await loadAgentLoopWithVectorCache({ VECTOR_CACHE_READ_ENABLED: true });
    findSimilarMock.mockResolvedValue([fakeCandidate({ targetAccessibleName: 'Baska Bir Buton', similarity: 0.99 })]);
    const { provider } = scriptedLlm([
      decisionJson({ action: 'click', targetRef: 'e1', confidence: 0.9 }),
      decisionJson({ action: 'finish_success', confidence: 0.95, summary: 'x', targetRef: undefined }),
    ]);
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-cache-no-el-match', url: 'https://example.com', scenario: 'test', options: fakeOptions({ maxSteps: 5 }) });

    expect(report.status).toBe('passed');
    expect(report.llmCallCount).toBe(2);
  });

  it('ilk aday guvenli degilse, sonraki uygun aday kullanilir', async () => {
    const { AgentLoop, findSimilarMock } = await loadAgentLoopWithVectorCache({ VECTOR_CACHE_READ_ENABLED: true });
    // NOT: yine SADECE bir kez (bkz. bir onceki testteki ayni gerekce) — 1. adim cache'ten
    // (ikinci adaydan) gelsin, 2. adimda findSimilar bos donup normal LLM akisina dusulsun.
    findSimilarMock
      .mockResolvedValueOnce([
        fakeCandidate({ action: 'fill', value: 'x', similarity: 0.99 }), // veri tasiyan -> guvenli degil
        fakeCandidate({ action: 'click', similarity: 0.98 }), // guvenli VE eslesen element var
      ])
      .mockResolvedValue([]);
    const completeMock = vi.fn().mockResolvedValue(decisionJson({ action: 'finish_success', confidence: 0.95, summary: 'x', targetRef: undefined }));
    const provider: LlmProvider = { name: 'unused-if-cache-hits', complete: completeMock, validateConfig: vi.fn().mockResolvedValue(undefined) };
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-cache-second-candidate', url: 'https://example.com', scenario: 'test', options: fakeOptions({ maxSteps: 5 }) });

    expect(report.status).toBe('passed');
    expect(completeMock).toHaveBeenCalledTimes(1); // sadece finish_success icin
  });

  it('findSimilar hata firlatirsa run ETKILENMEZ, normal LLM akisina dusulur (best-effort)', async () => {
    const { AgentLoop, findSimilarMock } = await loadAgentLoopWithVectorCache({ VECTOR_CACHE_READ_ENABLED: true });
    findSimilarMock.mockRejectedValue(new Error('milvus erisilemez'));
    const { provider } = scriptedLlm([
      decisionJson({ action: 'click', targetRef: 'e1', confidence: 0.9 }),
      decisionJson({ action: 'finish_success', confidence: 0.95, summary: 'x', targetRef: undefined }),
    ]);
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-cache-search-fail', url: 'https://example.com', scenario: 'test', options: fakeOptions({ maxSteps: 5 }) });

    expect(report.status).toBe('passed');
    expect(report.llmCallCount).toBe(2);
  });

  it('cache karari da diger tum guvenlik kapilarindan (ör. bilinmeyen secret referansi) GECMEK ZORUNDADIR', async () => {
    const { AgentLoop, findSimilarMock } = await loadAgentLoopWithVectorCache({ VECTOR_CACHE_READ_ENABLED: true });
    // check aksiyonu guvenli listede ama value alaninda tanimsiz bir secret referansi tasiyor
    // (gercekci degil ama gate 2'nin cache kararlarina da uygulandigini dogrulamak icin yeterli).
    findSimilarMock.mockResolvedValue([fakeCandidate({ action: 'check', value: '{{secret.UNKNOWN}}', similarity: 0.99 })]);
    const provider: LlmProvider = { name: 'unused', complete: vi.fn(), validateConfig: vi.fn().mockResolvedValue(undefined) };
    const loop = new AgentLoop(provider);

    const report = await loop.run({ runId: 'r-cache-unknown-ref', url: 'https://example.com', scenario: 'test', options: fakeOptions({ maxSteps: 5 }) });

    expect(report.status).toBe('failed');
    expect(report.failureReason).toContain('unknown_reference');
  });

  it(
    'LLM bir karar verip vector cache YAZDIKTAN hemen sonra (fire-and-forget), ' +
      'AYNI adayi bir SONRAKI adimda kendi kendine onermez (bkz. sohbet notu: hepsiburada ' +
      'arama kutusuna iki kez ust uste tiklanip zaman asimi hatasi)',
    async () => {
      const { AgentLoop, findSimilarMock } = await loadAgentLoopWithVectorCache({ VECTOR_CACHE_READ_ENABLED: true });
      // 1. adimda cache BOS doner (henuz Milvus'a hicbir sey yazilmadi) -> LLM 'click e1' karari
      // verir (e1: button/button/'Gonder' - bkz. fakeSnapshot). 2. adimdan itibaren findSimilar,
      // TAM OLARAK bu kararla ayni yapisal imzaya sahip bir adayi donmeye baslar - gercek hayatta bu,
      // recordDecisionInCache'in (fire-and-forget) LLM'in 1. adimdaki kararini Milvus'a yazip 2. adimin
      // okuma sorgusunun bu YENI yazilan kaydi (sourceRunId = kendi run'i) BULMASI durumunu simule
      // ediyor. Fix OLMADAN: 2. adim da cache'ten 'click e1' alir -> ayni aksiyon + degismeyen
      // stateHash -> LoopGuard 'loop_detected' ile run'i durdurur (asla finish_success'e ulasilmaz).
      findSimilarMock.mockResolvedValueOnce([]).mockResolvedValue([fakeCandidate({ similarity: 0.99 })]);
      const { provider, } = scriptedLlm([
        decisionJson({ action: 'click', targetRef: 'e1', confidence: 0.9 }),
        decisionJson({ action: 'finish_success', confidence: 0.95, summary: 'x', targetRef: undefined }),
      ]);
      const loop = new AgentLoop(provider);

      const report = await loop.run({ runId: 'r-cache-self-match', url: 'https://example.com', scenario: 'test', options: fakeOptions({ maxSteps: 5 }) });

      // Fix sayesinde: 1. adim LLM'den gelir (cache bos, henuz hicbir imza kullanilmadi), aksiyonun
      // imzasi usedCacheSignatures'a eklenir; 2. adimda AYNI imzali cache adayi bulunsa da SESSIZCE
      // atlanir ve LLM'e danisilir (finish_success), run BASARIYLA biter.
      expect(report.status).toBe('passed');
      expect(report.llmCallCount).toBe(2);
      expect(report.steps[0]?.decision.decisionSource).toBe('llm');
      expect(report.steps[1]?.decision.decisionSource).toBe('llm');
    },
  );
});
