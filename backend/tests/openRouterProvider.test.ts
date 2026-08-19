import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `env.js` doğrudan `process.env` yerine `vi.doMock` ile SAHTELENIYOR — bkz. geminiProvider.test.ts
 * dosya başı açıklaması, AYNI iki gerekçe burada da geçerli.
 */

const ENV_MODULE = '../src/config/env.js';

function baseEnv(overrides: Record<string, unknown> = {}) {
  return {
    PORT: 4000,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    LLM_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'test-key',
    OPENROUTER_MODEL: 'meta-llama/llama-3.3-70b-instruct:free',
    OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENROUTER_SITE_URL: undefined,
    OPENROUTER_APP_NAME: undefined,
    GEMINI_API_KEY: undefined,
    GEMINI_MODEL: 'gemini-test-model',
    GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta',
    AGENT_MAX_STEPS: 5,
    AGENT_MAX_REPEATED_ACTIONS: 3,
    AGENT_MIN_CONFIDENCE: 0.5,
    AGENT_STEP_TIMEOUT_MS: 5000,
    AGENT_MAX_ELEMENTS_PER_STEP: 20,
    AGENT_LLM_TIMEOUT_MS: 5000,
    PLAYWRIGHT_HEADLESS: true,
    PLAYWRIGHT_NAV_TIMEOUT_MS: 5000,
    PLAYWRIGHT_DEFAULT_TIMEOUT_MS: 5000,
    RUNS_DIR: './runs',
    ARTIFACTS_DIR: './artifacts',
    GENERATED_TESTS_DIR: './generated-tests',
    LEGACY_DEFAULT_BROWSER: 'chromium',
    FRONTEND_DIR: '../frontend',
    ...overrides,
  };
}

async function loadOpenRouterProvider(envOverrides: Record<string, unknown> = {}) {
  vi.resetModules();
  vi.doMock(ENV_MODULE, () => ({ env: baseEnv(envOverrides) }));
  const { OpenRouterProvider } = await import('../src/core/llm/OpenRouterProvider.js');
  return { OpenRouterProvider };
}

function fetchOkJson(body: unknown) {
  return { ok: true, status: 200, text: async () => '', json: async () => body };
}

describe('OpenRouterProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock(ENV_MODULE);
  });

  it('constructor: OPENROUTER_API_KEY boş/tanımsızsa hata fırlatır (ek güvenlik ağı)', async () => {
    const { OpenRouterProvider } = await loadOpenRouterProvider({ OPENROUTER_API_KEY: undefined });

    expect(() => new OpenRouterProvider()).toThrow(/OPENROUTER_API_KEY/);
  });

  it('complete(): normal (kesilmemiş) bir yanıtta content\'i doğrudan döner, tek istek atar', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        fetchOkJson({ choices: [{ message: { content: 'merhaba dünya' }, finish_reason: 'stop' }] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { OpenRouterProvider } = await loadOpenRouterProvider();
    const provider = new OpenRouterProvider();

    const result = await provider.complete([{ role: 'user', content: 'selam' }]);

    expect(result).toBe('merhaba dünya');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it(
    'complete(): finish_reason="length" olsa bile content DOLU ise (yarıda kesilmiş içerik), yine de daha ' +
      'yüksek max_tokens ile tekrar dener ve tam içeriği döner (canlıda gözlemlenen ScenarioSuggester ' +
      '"Unterminated string in JSON" hatasının kök nedeni — bu provider OpenRouter, projenin VARSAYILAN LLM sağlayıcısı)',
    async () => {
      const truncated = '[{"title": "X", "scenario": "kesik metin bura';
      const complete = '[{"title": "X", "scenario": "tam metin burada"}]';
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          fetchOkJson({ choices: [{ message: { content: truncated }, finish_reason: 'length' }] }),
        )
        .mockResolvedValueOnce(
          fetchOkJson({ choices: [{ message: { content: complete }, finish_reason: 'stop' }] }),
        );
      vi.stubGlobal('fetch', fetchMock);

      const { OpenRouterProvider } = await loadOpenRouterProvider();
      const provider = new OpenRouterProvider();

      const result = await provider.complete([{ role: 'user', content: 'öneri ver' }]);

      expect(result).toBe(complete);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // İkinci istek DAHA YÜKSEK bir max_tokens ile atılmış olmalı (varsayılan 1024'ün 3 katı).
      const secondCallBody = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(secondCallBody.max_tokens).toBeGreaterThan(1024);
    },
  );

  it('complete(): "reasoning" modeli tüm bütçeyi iç düşünceye harcayıp content\'i TAMAMEN boş bırakırsa, daha yüksek bütçeyle tekrar dener (ESKİDEN de ele alınan durum — bkz. yukarıdaki test, artık bunun GENELLEŞTİRİLMİŞ hâli)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        fetchOkJson({
          choices: [{ message: { content: '', reasoning: 'uzun bir iç düşünce süreci...' }, finish_reason: 'length' }],
        }),
      )
      .mockResolvedValueOnce(fetchOkJson({ choices: [{ message: { content: 'tam yanıt' }, finish_reason: 'stop' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const { OpenRouterProvider } = await loadOpenRouterProvider();
    const provider = new OpenRouterProvider();

    const result = await provider.complete([{ role: 'user', content: 'öneri ver' }]);

    expect(result).toBe('tam yanıt');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('complete(): yeniden deneme de BOŞ dönerse, elimizdeki (ilk, kesik) içeriği boş dönmektense yine de döner', async () => {
    const truncated = '[{"title": "X", "scenario": "kesik metin bura';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fetchOkJson({ choices: [{ message: { content: truncated }, finish_reason: 'length' }] }))
      .mockResolvedValueOnce(fetchOkJson({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const { OpenRouterProvider } = await loadOpenRouterProvider();
    const provider = new OpenRouterProvider();

    const result = await provider.complete([{ role: 'user', content: 'öneri ver' }]);

    expect(result).toBe(truncated);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('complete(): hiç content yoksa ve finish_reason "length" değilse (retry mantığı hiç tetiklenmez) anlaşılır bir hata fırlatır', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fetchOkJson({ choices: [{ message: {}, finish_reason: 'stop' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const { OpenRouterProvider } = await loadOpenRouterProvider();
    const provider = new OpenRouterProvider();

    await expect(provider.complete([{ role: 'user', content: 'selam' }])).rejects.toThrow(
      /OpenRouter yanıtında içerik bulunamadı/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
