import path from 'node:path';
import { nanoid } from 'nanoid';
import type { RunArtifacts, RunOptions, RunReport } from '../../domain/types.js';
import type {
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
          // SADECE report.status === 'passed' iken doludur (bkz. RunReport.replaySteps) — bu
          // sayede "Replay (No AI)" butonu sadece güvenilir şekilde tekrar oynatılabilecek
          // testler için etkinleşir.
          replaySteps: report.replaySteps,
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

function toArtifactUrls(runId: string, artifacts?: RunArtifacts): { screenshot?: string; video?: string; trace?: string } {
  if (!artifacts) return {};
  const out: { screenshot?: string; video?: string; trace?: string } = {};
  if (artifacts.screenshotPath) out.screenshot = `/artifacts/${runId}/screenshot.png`;
  if (artifacts.tracePath) out.trace = `/artifacts/${runId}/trace.zip`;
  if (artifacts.videoPath) out.video = `/artifacts/${runId}/video/${path.basename(artifacts.videoPath)}`;
  return out;
}
