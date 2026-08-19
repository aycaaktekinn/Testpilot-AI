import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrowserEngine, RunReport, RunStatus, StepLogEntry } from '../../domain/types.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('AllureReportService');
const execFileAsync = promisify(execFile);

const GENERATE_TIMEOUT_MS = 60_000;

/**
 * RunReport (bu projenin kendi PASS/FAIL/hata modeli) ile Allure'ın beklediği `*-result.json`
 * dosya formatı arasındaki köprü.
 *
 * NEDEN elle JSON yazıyoruz (standart bir reporter paketi KULLANMIYORUZ): AgentLoop testleri
 * `@playwright/test` test çalıştırıcısı ÜZERİNDEN çalıştırmıyor — kendi adım-adım AI karar
 * döngüsünü kullanıyor (bkz. AgentLoop dosya başı açıklaması). Bu yüzden `allure-playwright`
 * gibi bir reporter'ın bağlanacağı bir @playwright/test yaşam döngüsü YOK. `allure-js-commons`
 * paketinin çalışma zamanı (runtime) API'si de (adım adım, test SÜRERKEN çağrılan) bize uymuyor
 * — biz zaten TAMAMLANMIŞ bir RunReport'u dönüştürüyoruz. Bunun yerine, Allure'ın resmi/belgelenmiş
 * sonuç dosyası şemasına uygun JSON'u doğrudan kendimiz üretiyoruz; format stabil ve dile bağımsız
 * olduğu için (birçok farklı dil/ekosistem aynı formatı üretir) bu güvenilir bir yaklaşımdır.
 *
 * Statik HTML raporu, "allure" npm paketinin (Allure Report 3) CLI'ı ile üretilir
 * (`allure generate <sonuçlar> --clean -o <rapor>`). Rapor `ALLURE_REPORT_DIR` altına yazılır ve
 * backend bunu `/allure-report` altında statik olarak sunar (bkz. app.ts).
 */
export class AllureReportService {
  private readonly resultsDir = path.resolve(env.ALLURE_RESULTS_DIR);
  private readonly reportDir = path.resolve(env.ALLURE_REPORT_DIR);

  /**
   * Bir run tamamlandığında çağrılır. BİLE İSTEĞE BAĞLI (best-effort): burada oluşan bir hata
   * ASLA generateAndRun()'ın kullanıcıya döndürdüğü PASS/FAIL sonucunu bozmamalı — sadece loglanır.
   * (Aynı desen GeneratedTestStore.save()/TestRunStore.append() için de LegacyTestService'te
   * zaten uygulanıyor.)
   */
  async writeResultForRun(report: RunReport, browserEngine: BrowserEngine): Promise<void> {
    try {
      await mkdir(this.resultsDir, { recursive: true });

      const uuid = randomUUID();
      const payload = this.buildResult(report, browserEngine, uuid);
      const filePath = path.join(this.resultsDir, `${uuid}-result.json`);

      await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (err) {
      log.warn({ err, runId: report.runId }, 'Allure sonuç dosyası yazılamadı (yanıt yine de döndürülüyor)');
    }
  }

  /**
   * `allure generate` CLI'ını çalıştırıp statik HTML raporunu üretir. Bu bir "iş mantığı" hatası
   * (ör. Java/JVM kurulu değil) olabileceğinden, çağıran tarafın generic bir 500 yerine anlaşılır
   * bir mesaj gösterebilmesi için HİÇBİR ZAMAN fırlatmaz — her zaman { ok, message } döner.
   */
  async generateReport(): Promise<{ ok: boolean; message: string }> {
    const hasResults = await this.hasAnyResults();
    if (!hasResults) {
      return { ok: false, message: 'Henüz hiç test koşumu kaydedilmedi; önce en az bir test çalıştırın.' };
    }

    const allureBin = path.join(
      process.cwd(),
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'allure.cmd' : 'allure',
    );

    try {
      await mkdir(this.reportDir, { recursive: true });
      await execFileAsync(allureBin, ['generate', this.resultsDir, '--clean', '-o', this.reportDir], {
        timeout: GENERATE_TIMEOUT_MS,
      });
      log.info({ resultsDir: this.resultsDir, reportDir: this.reportDir }, 'Allure raporu oluşturuldu');
      return { ok: true, message: 'Allure raporu oluşturuldu.' };
    } catch (err) {
      const message = this.friendlyGenerateError(err);
      log.error({ err }, 'Allure raporu oluşturulamadı');
      return { ok: false, message };
    }
  }

  /** Frontend'in "Open Last Report" butonunu, henüz üretilmemiş bir rapora yönlendirmemesi için. */
  async hasReport(): Promise<boolean> {
    try {
      await stat(path.join(this.reportDir, 'index.html'));
      return true;
    } catch {
      return false;
    }
  }

  private async hasAnyResults(): Promise<boolean> {
    try {
      const entries = await readdir(this.resultsDir);
      return entries.some((fileName) => fileName.endsWith('-result.json'));
    } catch {
      return false;
    }
  }

  private buildResult(report: RunReport, browserEngine: BrowserEngine, uuid: string) {
    const startMs = parseTimestamp(report.startedAt);
    const stopMs = report.finishedAt ? parseTimestamp(report.finishedAt) : startMs;

    return {
      uuid,
      // Aynı senaryo+URL'nin farklı koşumlarını Allure'da AYNI test "geçmişi" (trend grafiği)
      // altında birleştirebilmek için kararlı bir kimlik.
      historyId: createHash('sha1').update(`${report.url}::${report.scenario}`).digest('hex'),
      fullName: `${report.url} — ${report.scenario}`,
      name: truncate(report.scenario, 120) || 'Adsız senaryo',
      status: mapStatus(report.status),
      statusDetails: buildStatusDetails(report),
      stage: 'finished',
      steps: report.steps.map(buildAllureStep),
      attachments: [],
      parameters: [
        { name: 'URL', value: report.url },
        { name: 'Browser', value: browserEngine },
      ],
      labels: [
        { name: 'suite', value: 'TestPilot AI' },
        { name: 'framework', value: 'TestPilot AI Agent' },
        { name: 'tag', value: browserEngine },
      ],
      links: [],
      start: startMs,
      stop: stopMs,
    };
  }

  private friendlyGenerateError(err: unknown): string {
    const raw = extractErrorText(err);

    if (isEnoentError(err) || /command not found|not recognized as an internal/i.test(raw)) {
      return 'Allure CLI bulunamadı. Backend klasöründe "npm install" çalıştırıp tekrar deneyin.';
    }

    // Allure'ın Java tabanlı komutları (v2 "allure-commandline") JVM bulunamazsa genelde
    // stderr'de "java"/"jvm" geçen bir mesaj verir — v3'ün saf Node.js CLI'ı için bu artık
    // beklenmiyor, ama farklı bir kurulumla (ör. eski bir global "allure" komutu PATH'te) yine
    // de karşılaşılabilir; kullanıcıya en azından NEDEN başarısız olduğuna dair bir ipucu verelim.
    if (/java|jvm/i.test(raw) && /(not found|no such file|unable to find|is not recognized)/i.test(raw)) {
      return 'Java (JVM) bulunamadı. Bu sistemdeki Allure kurulumu Java gerektiriyor olabilir — Java 8+ kurup tekrar deneyin.';
    }

    return raw ? `Rapor oluşturulamadı: ${truncate(raw, 400)}` : 'Rapor oluşturulamadı (bilinmeyen hata).';
  }
}

function mapStatus(status: RunStatus): 'passed' | 'failed' | 'broken' | 'skipped' | 'unknown' {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'error':
      return 'broken';
    case 'cancelled':
      return 'skipped';
    default:
      return 'unknown';
  }
}

function buildStatusDetails(report: RunReport): { message?: string } {
  if (report.status === 'passed') return {};
  return { message: report.failureReason ?? 'Bilinmeyen hata' };
}

function buildAllureStep(step: StepLogEntry) {
  const startMs = parseTimestamp(step.timestamp);
  const stopMs = startMs + Math.max(0, step.durationMs);
  const target = step.decision.targetRef ? ` -> ${step.decision.targetRef}` : '';

  return {
    name: `Adım ${step.stepIndex + 1}: ${step.decision.action}${target} — ${step.actionResult.message}`,
    status: step.actionResult.ok ? ('passed' as const) : ('failed' as const),
    statusDetails: step.actionResult.ok ? {} : { message: step.actionResult.message },
    stage: 'finished',
    steps: [],
    attachments: [],
    parameters: [],
    start: startMs,
    stop: stopMs,
  };
}

function parseTimestamp(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

function isEnoentError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'ENOENT';
}

function extractErrorText(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return [e.stderr, e.stdout, e.message].filter(Boolean).join('\n').trim();
  }
  return String(err);
}
