import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { baseEnv } from './helpers/fakeEnv.js';
import type { RunReport } from '../src/domain/types.js';

const ENV_MODULE = '../src/config/env.js';

function fixtureReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    runId: 'run-1',
    status: 'passed',
    url: 'https://example.com',
    scenario: 'Örnek senaryo',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:05.000Z',
    totalSteps: 1,
    llmCallCount: 1,
    steps: [
      {
        stepIndex: 0,
        timestamp: '2026-01-01T00:00:01.000Z',
        url: 'https://example.com',
        decision: {
          reasoning: 'Ara butonuna tıklamalıyım',
          confidence: 0.9,
          action: 'click',
          targetRef: 'e1',
          summary: 'Ara butonuna tıklandı',
        },
        actionResult: { ok: true, message: 'Tıklama başarılı' },
        durationMs: 120,
      },
    ],
    ...overrides,
  };
}

describe('AllureReportService', () => {
  let tmpDir: string;
  let resultsDir: string;
  let reportDir: string;
  let artifactsSourceDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'allure-service-'));
    // ALLURE_RESULTS_DIR/ALLURE_REPORT_DIR bilerek henüz VAR OLMAYAN alt klasörler olarak veriliyor
    // — writeResultForRun() bunları kendi (mkdir recursive) oluşturmalı.
    resultsDir = path.join(tmpDir, 'allure-results-subdir');
    reportDir = path.join(tmpDir, 'allure-report-subdir');
    // Gerçek kanıt (screenshot/trace/video) dosyalarının "diskte zaten var" olduğu yeri simüle
    // eder — AllureReportService'in kopyalayacağı KAYNAK, ARTIFACTS_DIR ile karışmasın diye ayrı.
    artifactsSourceDir = path.join(tmpDir, 'artifacts-source');
    mkdirSync(artifactsSourceDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.doUnmock(ENV_MODULE);
    vi.resetModules();
  });

  async function loadService() {
    vi.doMock(ENV_MODULE, () => ({ env: baseEnv({ ALLURE_RESULTS_DIR: resultsDir, ALLURE_REPORT_DIR: reportDir }) }));
    const mod = await import('../src/core/legacy/AllureReportService.js');
    return new mod.AllureReportService();
  }

  function readSingleResultFile(): any {
    const files = readdirSync(resultsDir).filter((f) => f.endsWith('-result.json'));
    expect(files).toHaveLength(1);
    return JSON.parse(readFileSync(path.join(resultsDir, files[0]), 'utf-8'));
  }

  it('writeResultForRun(): artifacts yoksa (undefined) boş bir attachments dizisi yazar', async () => {
    const service = await loadService();

    await service.writeResultForRun(fixtureReport({ artifacts: undefined }), 'chromium');

    const payload = readSingleResultFile();
    expect(payload.attachments).toEqual([]);
    // Adım listesi (Allure'ın zaten sağladığı adım-adım görünüm) her zaman doldurulmalı.
    expect(payload.steps).toHaveLength(1);
    expect(payload.steps[0].name).toContain('click');
  });

  it('writeResultForRun(): screenshot/trace/video varsa, dosyaları resultsDir İÇİNE kopyalar ve attachment girdisi ekler', async () => {
    const service = await loadService();

    const screenshotPath = path.join(artifactsSourceDir, 'screenshot.png');
    const tracePath = path.join(artifactsSourceDir, 'trace.zip');
    const videoPath = path.join(artifactsSourceDir, 'video.webm');

    writeFileSync(screenshotPath, 'sahte-png-icerik');
    writeFileSync(tracePath, 'sahte-zip-icerik');
    writeFileSync(videoPath, 'sahte-webm-icerik');

    await service.writeResultForRun(
      fixtureReport({ artifacts: { screenshotPath, tracePath, videoPath } }),
      'chromium',
    );

    const payload = readSingleResultFile();

    expect(payload.attachments).toHaveLength(3);

    const byName = Object.fromEntries(payload.attachments.map((a: any) => [a.name, a]));

    expect(byName.Screenshot.type).toBe('image/png');
    expect(byName.Trace.type).toBe('application/zip');
    expect(byName.Video.type).toBe('video/webm');

    // Her attachment'ın `source` alanı, resultsDir İÇİNDE GERÇEKTEN VAR OLAN bir dosyayı
    // göstermeli — Allure kaynağı SADECE kendi results klasöründe arar, orijinal
    // (ARTIFACTS_DIR) konumuna referans veremez.
    for (const attachment of payload.attachments) {
      const copiedPath = path.join(resultsDir, attachment.source);
      expect(existsSync(copiedPath)).toBe(true);
    }
  });

  it('writeResultForRun(): bir artifact dosyası diskte yoksa (silinmiş), o attachment sessizce atlanır, diğerleri ve rapor bozulmaz', async () => {
    const service = await loadService();

    const missingScreenshotPath = path.join(artifactsSourceDir, 'yok-olan-screenshot.png');
    const tracePath = path.join(artifactsSourceDir, 'trace.zip');
    writeFileSync(tracePath, 'sahte-zip-icerik');

    await expect(
      service.writeResultForRun(
        fixtureReport({ artifacts: { screenshotPath: missingScreenshotPath, tracePath } }),
        'chromium',
      ),
    ).resolves.toBeUndefined();

    const payload = readSingleResultFile();

    // Sadece var olan (trace) attachment eklenmeli — best-effort prensibi.
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].name).toBe('Trace');
    expect(payload.status).toBe('passed');
  });
});
