/**
 * Ortak sahte `env` üretici — birden fazla test dosyası tarafından paylaşılır.
 *
 * NEDEN: `config/env.js`'i gerçek `process.env`'e bağlı bırakmak testleri kullanıcının GERÇEK
 * `.env` dosyasının o an ne içerdiğine bağımlı kılar (ör. OPENROUTER_API_KEY tanımlı değilse
 * env.ts import anında fırlar). Bunun yerine her test dosyası `vi.doMock('../src/config/env.js',
 * () => ({ env: baseEnv(overrides) }))` deseniyle bu sabit, geçerli sahte env nesnesini kullanır
 * (bkz. tests/geminiProvider.test.ts — bu proje için kanonik desen buradan alınmıştır).
 */
export function baseEnv(overrides: Record<string, unknown> = {}) {
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
    ALLURE_RESULTS_DIR: './allure-results',
    ALLURE_REPORT_DIR: './allure-report',
    LEGACY_DEFAULT_BROWSER: 'chromium',
    // v2.0 — Selenium Grid hub adresi (bkz. SeleniumGridClient dosya başı açıklaması).
    // Testlerde varsayılan olarak TANIMSIZ: Grid'in "yapılandırılmamış" davranışı (net bir
    // SeleniumGridError) varsayılan test ortamıdır; Grid'e özgü testler kendi override'ını verir.
    SELENIUM_GRID_URL: undefined,
    // v2.0 — Vector cache (bkz. VectorCacheStore dosya başı açıklaması). Testlerde varsayılan
    // olarak KAPALI: `vectorCacheInstance.ts` bu durumda `null` üretir, Milvus'a hiçbir bağlantı
    // denemesi yapılmaz. Vector cache'e özgü testler kendi override'ını verir.
    VECTOR_CACHE_ENABLED: false,
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_EMBEDDING_MODEL: undefined,
    MILVUS_URL: 'http://localhost:19530',
    // v2.0 Faz 2 — okuma tarafı (bkz. AgentLoop.tryVectorCacheHit). Testlerde varsayılan olarak
    // KAPALI: LLM çağrısını atlama davranışına özgü testler kendi override'ını verir.
    VECTOR_CACHE_READ_ENABLED: false,
    VECTOR_CACHE_MIN_SIMILARITY: 0.92,
    VECTOR_CACHE_TOP_K: 5,
    FRONTEND_DIR: '../frontend',
    ...overrides,
  };
}

/**
 * `config/env.js`'in gerçek `defaultRunOptions` adlı named export'unun sahte karşılığı —
 * `baseEnv()`'in varsayılan alanlarıyla TUTARLI tutulmalıdır (bkz. gerçek env.ts). `env.js`'i
 * tamamen mockluyorsak, bu modülü import eden dosyalar (ScenarioSuggester, LegacyTestService)
 * `defaultRunOptions`'ı da BEKLER; sadece `env`'i sahteleyip bunu unutmak "Cannot convert
 * undefined or null to object" gibi bir çalışma zamanı hatasına yol açar.
 */
export function baseDefaultRunOptions(overrides: Record<string, unknown> = {}) {
  return {
    maxSteps: 5,
    headless: true,
    stepTimeoutMs: 5000,
    navigationTimeoutMs: 5000,
    defaultActionTimeoutMs: 5000,
    maxElementsPerStep: 20,
    maxRepeatedActions: 3,
    minConfidence: 0.5,
    viewport: { width: 1366, height: 900 },
    browserEngine: 'chromium',
    captureScreenshot: false,
    captureVideo: false,
    captureTrace: false,
    useSeleniumGrid: false,
    ...overrides,
  };
}
