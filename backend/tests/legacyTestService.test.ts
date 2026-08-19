import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { baseDefaultRunOptions, baseEnv } from './helpers/fakeEnv.js';
import type { LlmProvider } from '../src/core/llm/LlmProvider.js';
import type { RunReport } from '../src/domain/types.js';
import type { LegacyGenerateAndRunInput } from '../src/domain/legacyTypes.js';

/**
 * LegacyTestService, eski frontend'in "Generate & Run" akışını AgentLoop'a bağlayan uyum
 * katmanıdır. Burada AgentLoop TAMAMEN sahtelenir (gerçek bir run hiç çalıştırılmaz) — asıl amaç
 * bu servisin KENDİ sorumluluklarını doğrulamaktır: tek-aktif-run kısıtlaması, üretilen kodun/
 * koşum kaydının diske GERÇEKTEN kalıcı hale gelmesi (GeneratedTestStore/TestRunStore burada
 * MOCKLANMAZ — gerçek dosya sistemi, geçici bir klasörde kullanılır) ve runManager'a doğru
 * olayların iletilmesi.
 */

const genDir = mkdtempSync(path.join(tmpdir(), 'legacy-generated-tests-'));
const runsDir = mkdtempSync(path.join(tmpdir(), 'legacy-runs-'));
afterAll(() => {
  rmSync(genDir, { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });
});

vi.mock('../src/config/env.js', () => ({
  env: baseEnv({ GENERATED_TESTS_DIR: genDir, RUNS_DIR: runsDir }),
  defaultRunOptions: baseDefaultRunOptions(),
}));

const runMock = vi.fn();
const cancelMock = vi.fn();
vi.mock('../src/core/agent/AgentLoop.js', () => ({
  AgentLoop: vi.fn().mockImplementation(() => ({ run: runMock, cancel: cancelMock })),
}));

const registerExternalRunMock = vi.fn();
const publishExternalEventMock = vi.fn();
vi.mock('../src/api/runManager.js', () => ({
  runManager: { registerExternalRun: registerExternalRunMock, publishExternalEvent: publishExternalEventMock },
}));

const { LegacyTestService } = await import('../src/core/legacy/LegacyTestService.js');
const { GeneratedTestStore } = await import('../src/core/legacy/GeneratedTestStore.js');

const fakeProvider: LlmProvider = { name: 'fake', complete: vi.fn() };

function fakeReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    runId: 'run-fixed',
    status: 'passed',
    url: 'https://example.com',
    scenario: 'Ana sayfayı ziyaret et',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:05.000Z',
    totalSteps: 1,
    llmCallCount: 1,
    steps: [
      {
        stepIndex: 0,
        timestamp: '2026-01-01T00:00:01.000Z',
        url: 'https://example.com',
        decision: { reasoning: 'ok', confidence: 0.9, action: 'finish_success', summary: 'Tamamlandı' },
        actionResult: { ok: true, message: 'Tamamlandı' },
        durationMs: 100,
      },
    ],
    ...overrides,
  };
}

function fakeInput(overrides: Partial<LegacyGenerateAndRunInput> = {}): LegacyGenerateAndRunInput {
  return {
    url: 'https://example.com',
    scenario: 'Ana sayfayı ziyaret et',
    headed: true,
    browser: 'chromium',
    screenshot: false,
    video: false,
    trace: false,
    variables: {},
    ...overrides,
  };
}

beforeEach(async () => {
  runMock.mockReset();
  cancelMock.mockReset();
  registerExternalRunMock.mockReset();
  publishExternalEventMock.mockReset();
  // TestRunStore.clear() ARTIK var (bkz. dosya sonundaki "koşum geçmişi yönetimi" describe bloğu)
  // ama burada BİLEREK kullanılmıyor: bu dosyadaki testler zaten benzersiz runId kullanıp `.find()`
  // ile sadece kendi kaydını arıyor, bu yüzden testler arası paylaşılan bir store'u her seferinde
  // temizlemeye gerek yok — Generated test store'u ise (dosya adları çakışabileceği için) temiz
  // başlatmak daha güvenli.
  await new GeneratedTestStore().clear();
});

describe('LegacyTestService.generateAndRun', () => {
  it('mutlu yol: PASS sonucunu döner, üretilen kodu ve koşum kaydını GERÇEKTEN diske kalıcı hale getirir', async () => {
    runMock.mockResolvedValue(fakeReport({ runId: 'run-happy' }));
    const service = new LegacyTestService(fakeProvider);

    const result = await service.generateAndRun(fakeInput());

    expect(result.status).toBe('passed');
    expect(result.generatedCode).toContain('@playwright/test');
    expect(result.testFile).toMatch(/\.spec\.ts$/);
    expect(result.result.exitCode).toBe(0);

    const listed = await service.listGeneratedTests();
    expect(listed.tests.some((t) => t.fileName === result.testFile)).toBe(true);

    const runs = await service.listTestRuns();
    const record = runs.runs.find((r) => r.testFile === result.testFile);
    expect(record).toBeDefined();
    expect(record?.status).toBe('passed');
    expect(record?.exitCode).toBe(0);
  });

  it('FAIL sonucu için de kayıt oluşturur ve errorOutput doldurur', async () => {
    runMock.mockResolvedValue(fakeReport({ runId: 'run-fail', status: 'failed', failureReason: 'unknown_reference: secret.X' }));
    const service = new LegacyTestService(fakeProvider);

    const result = await service.generateAndRun(fakeInput());

    expect(result.status).toBe('failed');
    expect(result.result.exitCode).toBe(1);
    expect(result.result.errorOutput).toContain('unknown_reference');
  });

  it('zaten aktif bir run varken ikinci bir generateAndRun() çağrısı ValidationError ile reddedilir', async () => {
    let resolveRun!: (report: RunReport) => void;
    runMock.mockImplementation(
      () =>
        new Promise<RunReport>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const service = new LegacyTestService(fakeProvider);

    const firstCall = service.generateAndRun(fakeInput());
    expect(service.getActiveRunId()).not.toBeNull();

    await expect(service.generateAndRun(fakeInput())).rejects.toThrow(/Zaten çalışan bir test var/);

    resolveRun(fakeReport({ runId: 'run-concurrent' }));
    await expect(firstCall).resolves.toBeDefined();
  });

  it('getActiveRunId(): run bitene kadar dolu, bittikten sonra tekrar null olur', async () => {
    let resolveRun!: (report: RunReport) => void;
    runMock.mockImplementation(
      () =>
        new Promise<RunReport>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const service = new LegacyTestService(fakeProvider);
    expect(service.getActiveRunId()).toBeNull();

    const pending = service.generateAndRun(fakeInput());
    expect(service.getActiveRunId()).not.toBeNull();
    expect(registerExternalRunMock).toHaveBeenCalledWith(service.getActiveRunId(), 'https://example.com', 'Ana sayfayı ziyaret et');

    resolveRun(fakeReport({ runId: 'run-active-id-test' }));
    await pending;

    expect(service.getActiveRunId()).toBeNull();
  });
});

describe('LegacyTestService.stop', () => {
  it('aktif run yoksa bilgilendirici bir mesajla (hata fırlatmadan) döner', async () => {
    const service = new LegacyTestService(fakeProvider);

    const result = await service.stop();

    expect(result.message).toContain('bulunamadı');
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('aktif run varsa loop.cancel()’ı çağırır ve durdurma isteğinin gönderildiğini bildirir', async () => {
    let resolveRun!: (report: RunReport) => void;
    runMock.mockImplementation(
      () =>
        new Promise<RunReport>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const service = new LegacyTestService(fakeProvider);
    const pending = service.generateAndRun(fakeInput());
    expect(service.getActiveRunId()).not.toBeNull();

    const result = await service.stop();

    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(result.message).toContain('Durdurma isteği gönderildi');

    resolveRun(fakeReport({ runId: 'run-stop-test' }));
    await pending;
  });
});

describe('LegacyTestService — üretilmiş test yönetimi', () => {
  it('deleteGeneratedTest()/clearGeneratedTests()/getGeneratedTestCode() gerçek store’a doğru şekilde delege eder', async () => {
    runMock.mockResolvedValue(fakeReport({ runId: 'run-for-delete' }));
    const service = new LegacyTestService(fakeProvider);
    const { testFile } = await service.generateAndRun(fakeInput());

    const { code } = await service.getGeneratedTestCode(testFile);
    expect(code).toContain('@playwright/test');

    await service.deleteGeneratedTest(testFile);
    const afterDelete = await service.listGeneratedTests();
    expect(afterDelete.tests.some((t) => t.fileName === testFile)).toBe(false);

    await service.generateAndRun(fakeInput());
    await service.generateAndRun(fakeInput());
    const cleared = await service.clearGeneratedTests();
    expect(cleared.count).toBeGreaterThanOrEqual(2);
    expect((await service.listGeneratedTests()).tests).toHaveLength(0);
  });

  it('runGeneratedTest(): kayıtlı testin url/senaryosunu yeniden kullanır, override edilen alanları (ör. headed) tercih eder', async () => {
    // NOT: GeneratedTestStore'a kaydedilen url, generateAndRun()'a verilen INPUT'un url'i DEĞİL,
    // AgentLoop'un DÖNDÜRDÜĞÜ report.url'idir (bkz. LegacyTestService.finalizeResult) — bu yüzden
    // burada fakeReport()'a da aynı url'i vermemiz gerekiyor, aksi halde sahte AgentLoop çalıştırma
    // isteği içeriği input'u değil, mock'lanmış (sabit) raporu yansıtır.
    runMock.mockResolvedValue(fakeReport({ runId: 'run-seed', url: 'https://example.com/original' }));
    const service = new LegacyTestService(fakeProvider);
    const { testFile } = await service.generateAndRun(fakeInput({ headed: true, url: 'https://example.com/original' }));

    runMock.mockResolvedValue(fakeReport({ runId: 'run-rerun' }));
    await service.runGeneratedTest(testFile, { headed: false });

    const lastCallArgs = runMock.mock.calls.at(-1)?.[0];
    expect(lastCallArgs.url).toBe('https://example.com/original');
    expect(lastCallArgs.options.headless).toBe(true); // override headed:false -> headless:true
  });
});

// NOT: clearTestRuns() TÜM koşum geçmişini siler — bu yüzden bu describe bloğu BİLEREK dosyanın
// EN SONUNDA duruyor (vitest aynı dosya içindeki testleri yukarıdan aşağıya sırayla çalıştırır).
// Yukarıdaki testler kendi benzersiz runId'lerini `.find()`/`.some()` ile aradığından bu sıralamadan
// etkilenmezler, ama clearTestRuns()'ın KENDİSİ paylaşılan store'u tamamen boşalttığı için ondan
// SONRA çalışacak, listTestRuns()'ın TAM içeriğine güvenen bir test burada OLMAMALI.
describe('LegacyTestService — koşum geçmişi yönetimi', () => {
  it('deleteTestRun()/clearTestRuns() gerçek store’a doğru şekilde delege eder', async () => {
    runMock.mockResolvedValue(fakeReport({ runId: 'run-for-run-delete' }));
    const service = new LegacyTestService(fakeProvider);
    await service.generateAndRun(fakeInput());

    const beforeDelete = await service.listTestRuns();
    expect(beforeDelete.runs.some((r) => r.id === 'run-for-run-delete')).toBe(true);

    await service.deleteTestRun('run-for-run-delete');
    const afterDelete = await service.listTestRuns();
    expect(afterDelete.runs.some((r) => r.id === 'run-for-run-delete')).toBe(false);

    runMock.mockResolvedValue(fakeReport({ runId: 'run-clear-1' }));
    await service.generateAndRun(fakeInput());
    runMock.mockResolvedValue(fakeReport({ runId: 'run-clear-2' }));
    await service.generateAndRun(fakeInput());

    const cleared = await service.clearTestRuns();
    expect(cleared.count).toBeGreaterThanOrEqual(2);
    expect((await service.listTestRuns()).runs).toHaveLength(0);
  });

  it('deleteTestRun(): var olmayan bir id verilirse hata fırlatır', async () => {
    const service = new LegacyTestService(fakeProvider);

    await expect(service.deleteTestRun('bilinmeyen-id')).rejects.toThrow();
  });
});
