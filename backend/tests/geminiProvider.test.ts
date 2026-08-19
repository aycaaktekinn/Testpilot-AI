import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `env.js` doğrudan `process.env` yerine `vi.doMock` ile SAHTELENIYOR. Bunun iki nedeni var:
 * 1) `process.env`'i doğrudan mutasyona uğratmak, vitest'in varsayılan 'threads' havuzunda
 *    dosyalar arasında SIZINTI yapabiliyor (worker thread'ler process.env'i canlı paylaşır) —
 *    bu da başka test dosyalarının (örn. agentLoopConfigValidation.test.ts) modül yükleme anında
 *    rastgele başarısız olmasına yol açabilir.
 * 2) Bu test, kullanıcının GERÇEK .env dosyasının o an ne içerdiğinden tamamen bağımsız olmalı.
 */

const ENV_MODULE = '../src/config/env.js';

function baseEnv(overrides: Record<string, unknown> = {}) {
  return {
    PORT: 4000,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    LLM_PROVIDER: 'gemini',
    OPENROUTER_API_KEY: undefined,
    OPENROUTER_MODEL: 'meta-llama/llama-3.3-70b-instruct:free',
    OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENROUTER_SITE_URL: undefined,
    OPENROUTER_APP_NAME: undefined,
    GEMINI_API_KEY: 'test-key',
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

async function loadGeminiProvider(envOverrides: Record<string, unknown> = {}) {
  vi.resetModules();
  vi.doMock(ENV_MODULE, () => ({ env: baseEnv(envOverrides) }));
  const { GeminiProvider } = await import('../src/core/llm/GeminiProvider.js');
  const { LlmConfigurationError } = await import('../src/domain/errors.js');
  return { GeminiProvider, LlmConfigurationError };
}

describe('GeminiProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock(ENV_MODULE);
  });

  it('validateConfig(): model 404 dönerse LlmConfigurationError fırlatır (non-retryable)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () =>
          JSON.stringify({
            error: {
              code: 404,
              message: 'This model models/gemini-test-model is no longer available to new users.',
              status: 'NOT_FOUND',
            },
          }),
        json: async () => ({ error: { code: 404, message: 'not found', status: 'NOT_FOUND' } }),
      }),
    );

    const { GeminiProvider, LlmConfigurationError } = await loadGeminiProvider();
    const provider = new GeminiProvider();

    await expect(provider.validateConfig()).rejects.toBeInstanceOf(LlmConfigurationError);
    await expect(provider.validateConfig()).rejects.toThrow(/gemini-test-model/);
  });

  it('validateConfig(): model gerçekten çağrılabiliyorsa (minimal generateContent isteği başarılı) sessizce döner', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '',
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'pong' }] }, finishReason: 'STOP' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { GeminiProvider } = await loadGeminiProvider();
    const provider = new GeminiProvider();

    await expect(provider.validateConfig()).resolves.toBeUndefined();
    // ÖNEMLİ: sadece bir "model bilgisi" GET'i değil, GERÇEK bir generateContent isteği atılmalı —
    // ListModels'ta "var" görünen ama generateContent'te 404 dönen modelleri de yakalayabilmek için.
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(':generateContent'), expect.anything());
  });

  it('validateConfig(): model ListModels\'ta "var" görünse bile gerçek generateContent isteği 404 dönerse LlmConfigurationError fırlatır (tam olarak yaşanan sorun)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () =>
          JSON.stringify({ error: { code: 404, message: 'This model ... is no longer available to new users.', status: 'NOT_FOUND' } }),
        json: async () => ({}),
      }),
    );

    const { GeminiProvider, LlmConfigurationError } = await loadGeminiProvider();
    const provider = new GeminiProvider();

    await expect(provider.validateConfig()).rejects.toBeInstanceOf(LlmConfigurationError);
  });

  it('validateConfig(): geçici bir hata (örn. 500) KESİN bir yapılandırma hatası değildir; run engellenmez', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'internal server error',
        json: async () => ({}),
      }),
    );

    const { GeminiProvider } = await loadGeminiProvider();
    const provider = new GeminiProvider();

    // 500 -> generic Error (LlmConfigurationError DEĞİL) -> validateConfig bunu yutar, fırlatmaz.
    await expect(provider.validateConfig()).resolves.toBeUndefined();
  });

  it('complete(): generateContent isteği 404 dönerse LlmConfigurationError fırlatır (sonsuza dek retry edilecek bir hata gibi ele alınmamalı)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => 'model not found',
        json: async () => ({}),
      }),
    );

    const { GeminiProvider, LlmConfigurationError } = await loadGeminiProvider();
    const provider = new GeminiProvider();

    await expect(provider.complete([{ role: 'user', content: 'merhaba' }])).rejects.toBeInstanceOf(
      LlmConfigurationError,
    );
  });

  it('constructor: GEMINI_MODEL boş/tanımsızsa LlmConfigurationError fırlatır (ek güvenlik ağı)', async () => {
    const { GeminiProvider, LlmConfigurationError } = await loadGeminiProvider({ GEMINI_MODEL: undefined });

    expect(() => new GeminiProvider()).toThrow(LlmConfigurationError);
  });

  it('constructor: GEMINI_API_KEY boş/tanımsızsa LlmConfigurationError fırlatır (ek güvenlik ağı)', async () => {
    const { GeminiProvider, LlmConfigurationError } = await loadGeminiProvider({ GEMINI_API_KEY: undefined });

    expect(() => new GeminiProvider()).toThrow(LlmConfigurationError);
  });

  it('complete(): finishReason=MAX_TOKENS olsa bile text DOLU ise (yarıda kesilmiş içerik), yine de daha yüksek bütçeyle tekrar dener ve tam metni döner (canlıda gözlemlenen "Unterminated string in JSON" hatasının kök nedeni)', async () => {
    const truncated = '[{"title": "X", "scenario": "kesik metin bura';
    const complete = '[{"title": "X", "scenario": "tam metin burada"}]';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ candidates: [{ content: { parts: [{ text: truncated }] }, finishReason: 'MAX_TOKENS' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ candidates: [{ content: { parts: [{ text: complete }] }, finishReason: 'STOP' }] }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { GeminiProvider } = await loadGeminiProvider();
    const provider = new GeminiProvider();

    const result = await provider.complete([{ role: 'user', content: 'öneri ver' }]);

    expect(result).toBe(complete);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // İkinci istek DAHA YÜKSEK bir maxOutputTokens ile atılmış olmalı (varsayılan 1024'ün 3 katı).
    const secondCallBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondCallBody.generationConfig.maxOutputTokens).toBeGreaterThan(1024);
  });

  it('complete(): yeniden deneme de BOŞ dönerse, elimizdeki (ilk, kesik) metni boş dönmektense yine de döner', async () => {
    const truncated = '[{"title": "X", "scenario": "kesik metin bura';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ candidates: [{ content: { parts: [{ text: truncated }] }, finishReason: 'MAX_TOKENS' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { GeminiProvider } = await loadGeminiProvider();
    const provider = new GeminiProvider();

    const result = await provider.complete([{ role: 'user', content: 'öneri ver' }]);

    expect(result).toBe(truncated);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
