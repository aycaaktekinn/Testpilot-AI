import path from 'node:path';
import { nanoid } from 'nanoid';
import type { RunArtifacts, RunOptions, RunReport } from '../../domain/types.js';
import type {
  BatchRunStartResult,
  LegacyGenerateAndRunInput,
  LegacyGeneratedTestMeta,
  LegacyRunExistingOverrides,
  LegacyRunRecord,
  LegacyTestResultResponse,
} from '../../domain/legacyTypes.js';
import { AgentLoop } from '../agent/AgentLoop.js';
import type { LlmProvider } from '../llm/LlmProvider.js';
import { defaultRunOptions } from '../../config/env.js';
import { synthesizeTestCode } from './codeSynthesizer.js';
import { buildBddSteps } from './buildBddSteps.js';
import { TestRunStore } from './TestRunStore.js';
import { GeneratedTestStore, buildGeneratedFileName } from './GeneratedTestStore.js';
import { AllureReportService } from './AllureReportService.js';
import { ValidationError } from '../../domain/errors.js';
import { createLogger } from '../../config/logger.js';
import { runManager } from '../../api/runManager.js';

const log = createLogger('LegacyTestService');

/**
 * Mevcut (korunan) frontend'in eski API sözleşmesini (POST /api/tests/generate-and-run,
 * /api/tests/stop, /api/test-runs, /api/generated-tests*) sistemin yeni, canlı-DOM-ajanı
 * mimarisine bağlayan uyum (adapter) katmanı. Frontend'e HİÇ dokunulmaz.
 *
 * Frontend bu akışı TEK SEFERDE (senaryo bitene kadar bloklayan) bir istek olarak tasarladığı
 * ve aynı anda birden fazla koşumu takip etmediği için, burada da tek bir "aktif run" modeli
 * kullanılır (RunManager'daki çoklu-run modelinden farklı olarak).
 */
export class LegacyTestService {
  private readonly testRunStore = new TestRunStore();
  private readonly generatedTestStore = new GeneratedTestStore();
  private readonly allureReportService = new AllureReportService();
  private activeLoop: AgentLoop | null = null;
  // Frontend'in POST /api/tests/generate-and-run bloklayan isteği HENÜZ sonuçlanmadan (test daha
  // bitmeden) bu runId'yi öğrenip `/ws/runs/:runId`'ye bağlanabilmesi için — bkz. getActiveRunId().
  private activeRunId: string | null = null;

  constructor(private readonly llmProvider: LlmProvider) {}

  async generateAndRun(input: LegacyGenerateAndRunInput): Promise<LegacyTestResultResponse> {
    if (this.activeLoop) {
      throw new ValidationError('Zaten çalışan bir test var. Önce mevcut testi durdurun.');
    }

    const runId = nanoid(12);
    const options: RunOptions = {
      ...defaultRunOptions,
      headless: !input.headed,
      browserEngine: input.browser,
      captureScreenshot: input.screenshot,
      captureVideo: input.video,
      captureTrace: input.trace,
      useSeleniumGrid: input.useSeleniumGrid,
    };

    // Run'ı, WS aboneleri için görünür kılmak amacıyla runManager'a kaydediyoruz (bkz.
    // registerExternalRun() dosya başı açıklaması). AgentLoop'a verilen onEvent callback'i her
    // olayı doğrudan runManager'a yayınlar — böylece frontend, bu istek daha sonuçlanmadan CANLI
    // adım adım ilerlemeyi WebSocket üzerinden izleyebilir.
    runManager.registerExternalRun(runId, input.url, input.scenario);
    const loop = new AgentLoop(this.llmProvider, (event) => runManager.publishExternalEvent(runId, event));
    this.activeLoop = loop;
    this.activeRunId = runId;

    const startedAtMs = Date.now();
    let report: RunReport;
    try {
      report = await loop.run({
        runId,
        url: input.url,
        scenario: input.scenario,
        variables: input.variables,
        // Secrets sadece bu run'ın ömrü boyunca bellekte kalır; aşağıdaki finalizeResult/
        // generatedTestStore.save() çağrısına ASLA geçirilmez (diske hiç yazılmaz).
        secrets: input.secrets,
        options,
      });
    } finally {
      this.activeLoop = null;
      this.activeRunId = null;
    }

    return this.finalizeResult(report, options, (Date.now() - startedAtMs) / 1000, input.variables);
  }

  /** Şu an aktif bir run varsa iptal eder. Frontend sonucu beklemez, en iyi çaba prensibiyle çalışır. */
  async stop(): Promise<{ message: string }> {
    if (!this.activeLoop) {
      return { message: 'Çalışan bir test bulunamadı.' };
    }
    this.activeLoop.cancel();
    return { message: 'Durdurma isteği gönderildi; ajan bir sonraki güvenli adımda duracak.' };
  }

  /**
   * Şu an aktif (henüz sonuçlanmamış) generate-and-run isteğinin runId'sini döner, yoksa null.
   * Frontend, "Generate & Run" tıklandıktan HEMEN sonra bunu kısa aralıklarla yoklayarak
   * runId'yi öğrenir ve canlı ilerleme için WebSocket bağlantısını açar.
   */
  getActiveRunId(): string | null {
    return this.activeRunId;
  }

  async listTestRuns(): Promise<{ runs: LegacyRunRecord[] }> {
    return { runs: await this.testRunStore.list() };
  }

  async deleteTestRun(id: string): Promise<{ id: string }> {
    await this.testRunStore.delete(id);
    return { id };
  }

  async clearTestRuns(): Promise<{ count: number }> {
    const count = await this.testRunStore.clear();
    return { count };
  }

  async listGeneratedTests(): Promise<{ tests: LegacyGeneratedTestMeta[] }> {
    return { tests: await this.generatedTestStore.list() };
  }

  async getGeneratedTestCode(fileName: string): Promise<{ code: string; fileName: string }> {
    const code = await this.generatedTestStore.getCode(fileName);
    return { code, fileName };
  }

  async deleteGeneratedTest(fileName: string): Promise<{ fileName: string }> {
    await this.generatedTestStore.delete(fileName);
    return { fileName };
  }

  async clearGeneratedTests(): Promise<{ count: number }> {
    const count = await this.generatedTestStore.clear();
    return { count };
  }

  async runGeneratedTest(fileName: string, overrides: LegacyRunExistingOverrides): Promise<LegacyTestResultResponse> {
    const meta = await this.generatedTestStore.getMeta(fileName);

    return this.generateAndRun({
      url: meta.url,
      scenario: meta.scenario,
      variables: meta.variables,
      headed: overrides.headed ?? meta.headed,
      browser: overrides.browser ?? meta.browser,
      screenshot: overrides.screenshot ?? meta.screenshot,
      video: overrides.video ?? meta.video,
      trace: overrides.trace ?? meta.trace,
      useSeleniumGrid: overrides.useSeleniumGrid ?? meta.useSeleniumGrid ?? false,
    });
  }

  /**
   * "Replay (No AI)" — daha önce PASSED ile bitmiş bir testin kayıtlı adımlarını (bkz.
   * LegacyGeneratedTestMeta.replaySteps), LLM'e HİÇ danışmadan, aynen yeniden oynatır. `generateAndRun`
   * ile AYNI "tek aktif run" bookkeeping'ini paylaşır (activeLoop/activeRunId) — aynı anda hem
   * normal bir run hem bir replay çalışamaz.
   */
  async replayGeneratedTest(fileName: string, overrides: LegacyRunExistingOverrides): Promise<LegacyTestResultResponse> {
    if (this.activeLoop) {
      throw new ValidationError('Zaten çalışan bir test var. Önce mevcut testi durdurun.');
    }

    const meta = await this.generatedTestStore.getMeta(fileName);
    if (!meta.replaySteps || meta.replaySteps.length === 0) {
      throw new ValidationError(
        'Bu test için AI\'sız tekrar oynatma verisi kayıtlı değil (orijinal koşum başarısız olmuş ya da daha eski bir sürümde üretilmiş olabilir). "Run" ile AI kullanarak çalıştırabilirsiniz.',
      );
    }

    const runId = nanoid(12);
    const options: RunOptions = {
      ...defaultRunOptions,
      headless: !(overrides.headed ?? meta.headed),
      browserEngine: overrides.browser ?? meta.browser,
      captureScreenshot: overrides.screenshot ?? meta.screenshot,
      captureVideo: overrides.video ?? meta.video,
      captureTrace: overrides.trace ?? meta.trace,
      useSeleniumGrid: overrides.useSeleniumGrid ?? meta.useSeleniumGrid ?? false,
    };

    runManager.registerExternalRun(runId, meta.url, meta.scenario);
    const loop = new AgentLoop(this.llmProvider, (event) => runManager.publishExternalEvent(runId, event));
    this.activeLoop = loop;
    this.activeRunId = runId;

    const startedAtMs = Date.now();
    let report: RunReport;
    try {
      report = await loop.run({
        runId,
        url: meta.url,
        scenario: meta.scenario,
        variables: meta.variables,
        replaySteps: meta.replaySteps,
        options,
      });
    } finally {
      this.activeLoop = null;
      this.activeRunId = null;
    }

    return this.finalizeResult(report, options, (Date.now() - startedAtMs) / 1000, meta.variables);
  }

  /**
   * v2.0 — checkbox ile seçilen birden fazla generated test'i GERÇEKTEN paralel olarak başlatır.
   * `generateAndRun`/`runGeneratedTest`/`replayGeneratedTest`'in aksine `activeLoop`/`activeRunId`
   * ("tek aktif run") bookkeeping'ini KULLANMAZ — bunun yerine doğrudan `runManager.startRun()`'a
   * gider, çünkü RunManager zaten her run için ayrı bir AgentLoop örneğiyle, bellekte
   * `Map<runId, ...>` olarak çoklu-run'ı native destekliyor (bkz. runManager.ts dosya başı NOT).
   *
   * Bloklamaz: her run için hemen bir runId döner, çağıran taraf ilerlemeyi `/ws/runs/:runId`
   * üzerinden ayrı ayrı takip eder. `runManager` KENDİSİ run bittiğinde Test Runs/Generated Tests
   * geçmişine YAZMAZ (bu sadece LegacyTestService'in bilinçli bir sorumluluğudur) — bu yüzden her
   * run için `run_finished` olayını dinleyip aynı `finalizeResult()`'ı burada da (arka planda)
   * çağırarak köprülüyoruz; aksi halde bu run'lar Reports/Test Runs sayfalarında hiç görünmezdi.
   *
   * v2.4 — "Mümkünse Replay (No AI)" denemesi sayfa değişmiş olduğu için 'replay_mismatch' ile
   * başarısız olursa, `runManager.startRunWithAutoRetry()` bunu OTOMATİK olarak, AYNI runId
   * altında, tam AI modunda yeniden dener (bkz. o metodun dosya başı açıklaması) — bu sayede
   * "Run Selected" artık dinamik/değişken sayfalarda da güvenilir şekilde sonuçlanır, kullanıcının
   * elle "Run (AI ile)" ile tek tek yeniden denemesi gerekmez. Sadece NİHAİ sonuç (başarısız replay
   * denemesi DEĞİL) `persistBatchRunWhenFinished` ile geçmişe kaydedilir — aşağıda hiçbir değişiklik
   * gerekmedi, çünkü o zaten sadece gerçek 'run_finished' olayını dinliyor.
   */
  async runGeneratedTestsBatch(fileNames: string[]): Promise<BatchRunStartResult[]> {
    const results: BatchRunStartResult[] = [];

    for (const fileName of fileNames) {
      try {
        const meta = await this.generatedTestStore.getMeta(fileName);

        const options: RunOptions = {
          ...defaultRunOptions,
          headless: !meta.headed,
          browserEngine: meta.browser,
          captureScreenshot: meta.screenshot,
          captureVideo: meta.video,
          captureTrace: meta.trace,
          useSeleniumGrid: meta.useSeleniumGrid ?? false,
        };

        // "Mümkünse Replay (No AI), yoksa Run" — bkz. TestRunRequest.replaySteps dosya başı NOT.
        const hasReplay = Boolean(meta.replaySteps && meta.replaySteps.length > 0);

        const summary = runManager.startRunWithAutoRetry({
          url: meta.url,
          scenario: meta.scenario,
          variables: meta.variables,
          options,
          replaySteps: hasReplay ? meta.replaySteps : undefined,
        });

        this.persistBatchRunWhenFinished(summary.runId, meta, options);

        results.push({ fileName, runId: summary.runId, mode: hasReplay ? 'replay' : 'run' });
      } catch (err) {
        results.push({ fileName, error: errorMessage(err, 'Test başlatılamadı.') });
      }
    }

    return results;
  }

  /**
   * runGeneratedTestsBatch() için yardımcı — bir run bittiğinde (PASS/FAIL) sonucu Test Runs/
   * Generated Tests geçmişine kalıcı hale getirir. Sadece run_finished'te çalışır: run_error
   * (beklenmeyen çökme) durumunda elde bir RunReport olmadığından kaydedilecek bir şey yoktur —
   * bu, runManager'ın kendisinin de run_error'da rapor ÜRETMEMESİYLE tutarlıdır.
   */
  private persistBatchRunWhenFinished(runId: string, meta: LegacyGeneratedTestMeta, options: RunOptions): void {
    const startedAtMs = Date.now();
    const unsubscribe = runManager.subscribe(runId, (event) => {
      if (event.type !== 'run_finished' && event.type !== 'run_error') return;
      unsubscribe();

      if (event.type === 'run_error') {
        log.warn({ runId, message: event.message }, 'Toplu çalıştırmadaki bir run beklenmeyen şekilde çöktü, geçmişe kaydedilemiyor');
        return;
      }

      void this.finalizeResult(event.report, options, (Date.now() - startedAtMs) / 1000, meta.variables).catch((err) => {
        log.error({ err, runId }, 'Toplu çalıştırma sonucu geçmişe kaydedilemedi');
      });
    });
  }

  private async finalizeResult(
    report: RunReport,
    options: RunOptions,
    durationSeconds: number,
    variables: Record<string, string>,
  ): Promise<LegacyTestResultResponse> {
    const status = report.status === 'passed' ? 'passed' : 'failed';
    const createdAt = report.finishedAt ?? new Date().toISOString();

    // Sentezlenen kodu + orijinal çalıştırma bağlamını diske kaydet (best-effort — başarısız
    // olursa yanıtı asla bozmaz, sadece loglanır).
    const code = synthesizeTestCode(report);
    const fileName = buildGeneratedFileName(report.scenario, report.runId);
    try {
      await this.generatedTestStore.save(
        {
          fileName,
          createdAt,
          url: report.url,
          scenario: report.scenario,
          variables,
          browser: options.browserEngine,
          headed: !options.headless,
          screenshot: options.captureScreenshot,
          video: options.captureVideo,
          trace: options.captureTrace,
          useSeleniumGrid: options.useSeleniumGrid,
          // SADECE report.status === 'passed' iken doludur (bkz. RunReport.replaySteps) — bu
          // sayede "Replay (No AI)" butonu sadece güvenilir şekilde tekrar oynatılabilecek
          // testler için etkinleşir.
          replaySteps: report.replaySteps,
          // BDD/step bazlı görüntüleme için — replaySteps'in aksine PASS/FAIL fark etmeksizin
          // doldurulur (bkz. BddStepView, buildBddSteps.ts dosya başı açıklaması).
          steps: buildBddSteps(report),
        },
        code,
      );
    } catch (err) {
      log.error({ err, runId: report.runId }, 'Üretilen test dosyası kaydedilemedi (yanıt yine de döndürülüyor)');
    }

    const exitCode = status === 'passed' ? 0 : 1;
    const message =
      status === 'passed'
        ? report.steps.at(-1)?.decision.summary ?? 'Senaryo başarıyla tamamlandı.'
        : (report.failureReason ?? 'Senaryo başarısız oldu.');

    const record: LegacyRunRecord = {
      id: report.runId,
      testFile: fileName,
      status,
      browser: options.browserEngine,
      duration: durationSeconds,
      createdAt,
      message,
      error: status === 'failed' ? message : undefined,
      errorOutput: status === 'failed' ? buildErrorOutput(report) : undefined,
      exitCode,
    };

    try {
      await this.testRunStore.append(record);
    } catch (err) {
      log.error({ err, runId: report.runId }, 'Koşum geçmişi kaydedilemedi (yanıt yine de döndürülüyor)');
    }

    // writeResultForRun() KENDİSİ zaten best-effort'tur (asla fırlatmaz) — bkz. AllureReportService
    // dosya başı açıklaması; burada ayrıca bir try/catch'e gerek yok.
    await this.allureReportService.writeResultForRun(report, options.browserEngine);

    return {
      generatedCode: code,
      testFile: fileName,
      status,
      message,
      result: {
        output: buildOutputLog(report, options.browserEngine),
        errorOutput: record.errorOutput ?? '',
        exitCode,
        artifacts: toArtifactUrls(report.runId, report.artifacts),
      },
    };
  }
}

function buildOutputLog(report: RunReport, browserEngine: string): string {
  const lines = [
    `Senaryo: ${report.scenario}`,
    `URL: ${report.url}`,
    `Tarayıcı motoru: ${browserEngine}`,
    `Durum: ${report.status.toUpperCase()}`,
    `Toplam adım: ${report.totalSteps} | LLM çağrısı: ${report.llmCallCount}`,
    '',
  ];
  for (const step of report.steps) {
    const d = step.decision;
    const target = d.targetRef ? ` -> ${d.targetRef}` : '';
    lines.push(
      `[Adım ${step.stepIndex + 1}] ${d.action}${target} | ${step.actionResult.ok ? 'OK' : 'HATA'}: ${step.actionResult.message}`,
    );
  }
  if (report.failureReason) {
    lines.push('', `Sonuç notu: ${report.failureReason}`);
  }
  return lines.join('\n');
}

function buildErrorOutput(report: RunReport): string {
  return report.failureReason ?? 'Bilinmeyen hata';
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function toArtifactUrls(runId: string, artifacts?: RunArtifacts): { screenshot?: string; video?: string; trace?: string } {
  if (!artifacts) return {};
  const out: { screenshot?: string; video?: string; trace?: string } = {};
  if (artifacts.screenshotPath) out.screenshot = `/artifacts/${runId}/screenshot.png`;
  if (artifacts.tracePath) out.trace = `/artifacts/${runId}/trace.zip`;
  if (artifacts.videoPath) out.video = `/artifacts/${runId}/video/${path.basename(artifacts.videoPath)}`;
  return out;
}
