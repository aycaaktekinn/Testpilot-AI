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
    LLM_PROVIDER: 'ollama',
    OPENROUTER_API_KEY: undefined,
    OPENROUTER_MODEL: 'meta-llama/llama-3.3-70b-instruct:free',
    OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
    OPENROUTER_SITE_URL: undefined,
    OPENROUTER_APP_NAME: undefined,
    GEMINI_API_KEY: undefined,
    GEMINI_MODEL: undefined,
    GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta',
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_MODEL: 'test-chat-model',
    OLLAMA_EMBEDDING_MODEL: undefined,
    MILVUS_URL: 'http://localhost:19530',
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

async function loadOllamaProvider(envOverrides: Record<string, unknown> = {}) {
  vi.resetModules();
  vi.doMock(ENV_MODULE, () => ({ env: baseEnv(envOverrides) }));
  const { OllamaProvider } = await import('../src/core/llm/OllamaProvider.js');
  const { LlmConfigurationError } = await import('../src/domain/errors.js');
  return { OllamaProvider, LlmConfigurationError };
}

function fetchOkJson(body: unknown) {
  return { ok: true, status: 200, text: async () => '', json: async () => body };
}

describe('OllamaProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock(ENV_MODULE);
  });

  it('constructor: OLLAMA_MODEL boş/tanımsızsa LlmConfigurationError fırlatır (ek güvenlik ağı)', async () => {
    const { OllamaProvider, LlmConfigurationError } = await loadOllamaProvider({ OLLAMA_MODEL: undefined });

    expect(() => new OllamaProvider()).toThrow(LlmConfigurationError);
  });

  it('complete(): normal (kesilmemiş) bir yanıtta content\'i doğrudan döner, tek istek atar (native /api/chat)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(fetchOkJson({ message: { role: 'assistant', content: 'merhaba dünya' }, done: true, done_reason: 'stop' }));
    vi.stubGlobal('fetch', fetchMock);

    const { OllamaProvider } = await loadOllamaProvider();
    const provider = new OllamaProvider();

    const result = await provider.complete([{ role: 'user', content: 'selam' }]);

    expect(result).toBe('merhaba dünya');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/api/chat', expect.anything());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe('test-chat-model');
    expect(body.stream).toBe(false);
  });

  it('complete(): done_reason="length" olsa bile content DOLU ise (yarıda kesilmiş içerik), daha yüksek num_predict ile tekrar dener ve tam içeriği döner', async () => {
    const truncated = '[{"title": "X", "scenario": "kesik metin bura';
    const complete = '[{"title": "X", "scenario": "tam metin burada"}]';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fetchOkJson({ message: { content: truncated }, done_reason: 'length' }))
      .mockResolvedValueOnce(fetchOkJson({ message: { content: complete }, done_reason: 'stop' }));
    vi.stubGlobal('fetch', fetchMock);

    const { OllamaProvider } = await loadOllamaProvider();
    const provider = new OllamaProvider();

    const result = await provider.complete([{ role: 'user', content: 'öneri ver' }]);

    expect(result).toBe(complete);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondCallBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(secondCallBody.options.num_predict).toBeGreaterThan(1024);
  });

  it('complete(): yeniden deneme de BOŞ dönerse, elimizdeki (ilk, kesik) içeriği boş dönmektense yine de döner', async () => {
    const truncated = '[{"title": "X", "scenario": "kesik metin bura';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fetchOkJson({ message: { content: truncated }, done_reason: 'length' }))
      .mockResolvedValueOnce(fetchOkJson({ message: { content: '' }, done_reason: 'length' }));
    vi.stubGlobal('fetch', fetchMock);

    const { OllamaProvider } = await loadOllamaProvider();
    const provider = new OllamaProvider();

    const result = await provider.complete([{ role: 'user', content: 'öneri ver' }]);

    expect(result).toBe(truncated);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('complete(): hiç content yoksa ve done_reason "length" değilse anlaşılır bir hata fırlatır', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fetchOkJson({ message: {}, done_reason: 'stop' }));
    vi.stubGlobal('fetch', fetchMock);

    const { OllamaProvider } = await loadOllamaProvider();
    const provider = new OllamaProvider();

    await expect(provider.complete([{ role: 'user', content: 'selam' }])).rejects.toThrow(
      /Ollama yanıtında içerik bulunamadı/,
    );
  });

  it('complete(): sunucuya hiç bağlanılamazsa (ör. `ollama serve` çalışmıyor) LlmConfigurationError fırlatır (geçici DEĞİL kabul edilir)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const { OllamaProvider, LlmConfigurationError } = await loadOllamaProvider();
    const provider = new OllamaProvider();

    await expect(provider.complete([{ role: 'user', content: 'selam' }])).rejects.toBeInstanceOf(
      LlmConfigurationError,
    );
  });

  it('complete(): model indirilmemişse ("not found, try pulling") LlmConfigurationError fırlatır', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: "model 'test-chat-model' not found, try pulling it first" }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { OllamaProvider, LlmConfigurationError } = await loadOllamaProvider();
    const provider = new OllamaProvider();

    await expect(provider.complete([{ role: 'user', content: 'selam' }])).rejects.toBeInstanceOf(
      LlmConfigurationError,
    );
  });

  it('validateConfig(): minimal bir /api/chat isteği başarılıysa sessizce döner (num_predict:1 ile)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fetchOkJson({ message: { content: 'pong' }, done_reason: 'stop' }));
    vi.stubGlobal('fetch', fetchMock);

    const { OllamaProvider } = await loadOllamaProvider();
    const provider = new OllamaProvider();

    await expect(provider.validateConfig()).resolves.toBeUndefined();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.options.num_predict).toBe(1);
  });

  it('validateConfig(): KESİN bir yapılandırma hatası (model bulunamadı) run\'ı erkenden durdurmak için fırlatılır', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "model 'test-chat-model' not found, try pulling it first",
    });
    vi.stubGlobal('fetch', fetchMock);

    const { OllamaProvider, LlmConfigurationError } = await loadOllamaProvider();
    const provider = new OllamaProvider();

    await expect(provider.validateConfig()).rejects.toBeInstanceOf(LlmConfigurationError);
  });

  it('validateConfig(): geçici bir hata (örn. 500) KESİN bir yapılandırma hatası değildir; run engellenmez', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'internal server error' });
    vi.stubGlobal('fetch', fetchMock);

    const { OllamaProvider } = await loadOllamaProvider();
    const provider = new OllamaProvider();

    await expect(provider.validateConfig()).resolves.toBeUndefined();
  });
});
