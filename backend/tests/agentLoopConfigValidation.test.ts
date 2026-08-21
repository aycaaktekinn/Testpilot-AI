import { describe, expect, it, vi } from 'vitest';
import type { LlmProvider } from '../src/core/llm/LlmProvider.js';
import type { RunOptions } from '../src/domain/types.js';
import { LlmConfigurationError } from '../src/domain/errors.js';

/**
 * Bu test, kullanıcının GERÇEK `.env` dosyasının o an ne içerdiğinden tamamen bağımsız olmalı
 * (AgentLoop'un genel akışını, sahte bir LlmProvider ile test ediyoruz — Gemini'ye özel hiçbir
 * şey yok). Bu yüzden `env.js`'i sabit, geçerli bir sahte nesneyle mockluyoruz.
 *
 * BrowserManager'ı da tamamen sahteleyerek, "yapılandırma hatası varsa Playwright/tarayıcı HİÇ
 * başlatılmaz" garantisini gerçek bir tarayıcı açmadan doğruluyoruz.
 */

vi.mock('../src/config/env.js', () => ({
  env: {
    PORT: 4000,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    LLM_PROVIDER: 'gemini',
    GEMINI_API_KEY: 'test-key',
    GEMINI_MODEL: 'gemini-test-model',
    GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta',
    OPENROUTER_API_KEY: undefined,
    OPENROUTER_MODEL: 'meta-llama/llama-3.3-70b-instruct:free',
    OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
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
  },
}));

const launchMock = vi.fn();
const closeMock = vi.fn().mockResolvedValue({});

vi.mock('../src/core/browser/BrowserManager.js', () => {
  return {
    BrowserManager: vi.fn().mockImplementation(() => ({
      launch: launchMock,
      captureScreenshot: vi.fn().mockResolvedValue(false),
      stopTracing: vi.fn().mockResolvedValue(false),
      close: closeMock,
    })),
  };
});

const { AgentLoop } = await import('../src/core/agent/AgentLoop.js');

function fakeOptions(): RunOptions {
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
  };
}

describe('AgentLoop — LLM yapılandırma ön-kontrolü (validateConfig)', () => {
  it('validateConfig() LlmConfigurationError fırlatırsa: Playwright hiç başlatılmaz, LLM hiç çağrılmaz, run anında "error" ile "configuration_error:" önekiyle biter', async () => {
    launchMock.mockClear();
    closeMock.mockClear();

    const completeMock = vi.fn();
    const provider: LlmProvider = {
      name: 'fake-config-error',
      complete: completeMock,
      validateConfig: vi.fn().mockRejectedValue(new LlmConfigurationError('GEMINI_MODEL="x" bulunamadı (404)')),
    };

    const loop = new AgentLoop(provider);
    const report = await loop.run({
      runId: 'test-run-config-error',
      url: 'https://example.com',
      scenario: 'Ana sayfayı aç',
      options: fakeOptions(),
    });

    expect(report.status).toBe('error');
    expect(report.failureReason).toContain('configuration_error');
    expect(report.failureReason).toContain('GEMINI_MODEL');
    expect(report.totalSteps).toBe(0);

    // En kritik doğrulama: tarayıcı HİÇ başlatılmadı, gerçek bir LLM tamamlama isteği HİÇ atılmadı.
    expect(launchMock).not.toHaveBeenCalled();
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('validateConfig() başarılıysa akış normal şekilde tarayıcı başlatmaya devam eder', async () => {
    launchMock.mockClear();
    closeMock.mockClear();
    launchMock.mockRejectedValue(new Error('test: sahte tarayıcı bilinçli olarak burada durduruluyor'));

    const provider: LlmProvider = {
      name: 'fake-ok',
      complete: vi.fn(),
      validateConfig: vi.fn().mockResolvedValue(undefined),
    };

    const loop = new AgentLoop(provider);
    const report = await loop.run({
      runId: 'test-run-config-ok',
      url: 'https://example.com',
      scenario: 'Ana sayfayı aç',
      options: fakeOptions(),
    });

    // validateConfig geçti, akış browserManager.launch()'a kadar ilerledi (orada bilinçli olarak
    // hata fırlatıldı) — yani ön-kontrol akışı bloklamıyor.
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(report.status).toBe('error');
    expect(report.failureReason).not.toContain('configuration_error');
  });
});
