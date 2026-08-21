import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunArtifacts, RunReport, ReplayStep, StepLogEntry } from '../../domain/types.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('RunLogger');

/**
 * Her test run'ı için adım adım JSON logları diske yazar ve PASS/FAIL raporunu üretir.
 * ÖNEMLİ: Bu katmana ULAŞAN her şey zaten maskelenmiş olmalıdır (secret değerleri asla burada olmamalı) —
 * bkz. SecretsVault.maskForLog ve AgentLoop.
 */
export class RunLogger {
  private readonly steps: StepLogEntry[] = [];
  private readonly runDir: string;
  private finalReport: RunReport | null = null;

  constructor(
    private readonly runId: string,
    private readonly url: string,
    private readonly scenario: string,
    private readonly startedAt: string,
  ) {
    this.runDir = path.resolve(env.RUNS_DIR);
  }

  addStep(entry: StepLogEntry): void {
    this.steps.push(entry);
  }

  getSteps(): StepLogEntry[] {
    return this.steps;
  }

  async finalize(
    status: RunReport['status'],
    llmCallCount: number,
    failureReason?: string,
    replaySteps?: ReplayStep[],
    seleniumGridLiveViewUrl?: string,
  ): Promise<RunReport> {
    const report: RunReport = {
      runId: this.runId,
      status,
      url: this.url,
      scenario: this.scenario,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      totalSteps: this.steps.length,
      llmCallCount,
      failureReason,
      steps: this.steps,
      replaySteps,
      seleniumGridLiveViewUrl,
    };

    this.finalReport = report;
    await this.persist(report);
    return report;
  }

  /**
   * Browser kapandıktan SONRA netleşen kanıtları (özellikle video yolu — Playwright videoyu
   * context kapanana kadar finalize etmez) zaten tamamlanmış rapora ekler ve diski günceller.
   * `finalize()` çağrılmadan önce çağrılırsa no-op'tur.
   */
  async attachArtifacts(artifacts: RunArtifacts): Promise<void> {
    if (!this.finalReport) return;
    const hasAny = Object.values(artifacts).some((v) => v !== undefined);
    if (!hasAny) return;

    this.finalReport.artifacts = { ...this.finalReport.artifacts, ...artifacts };
    await this.persist(this.finalReport);
  }

  private async persist(report: RunReport): Promise<void> {
    try {
      await mkdir(this.runDir, { recursive: true });
      const filePath = path.join(this.runDir, `${this.runId}.json`);
      await writeFile(filePath, JSON.stringify(report, null, 2), 'utf-8');
      log.info({ filePath, status: report.status }, 'Run raporu diske yazıldı');
    } catch (err) {
      log.error({ err, runId: this.runId }, 'Run raporu diske yazılamadı');
    }
  }
}
