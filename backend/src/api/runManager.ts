import { nanoid } from 'nanoid';
import type { RunReport, RunSummary, TestRunRequest } from '../domain/types.js';
import { AgentLoop } from '../core/agent/AgentLoop.js';
import type { AgentEvent, AgentEventListener } from '../core/agent/types.js';
import { createLlmProvider } from '../core/llm/createLlmProvider.js';
import { defaultRunOptions } from '../config/env.js';
import { NotFoundError } from '../domain/errors.js';
import { createLogger } from '../config/logger.js';

const log = createLogger('RunManager');

interface RunRecord {
  summary: RunSummary;
  report?: RunReport;
  // `loop` SADECE runManager.startRun() ile başlatılan run'larda dolu olur (cancelRun bunu
  // kullanır). LegacyTestService gibi run'ı KENDİSİ başlatıp sadece OLAYLARI buraya yayınlayan
  // ("external") kayıtlarda bu alan yoktur — o run'ların iptali kendi servisi üzerinden yapılır.
  loop?: AgentLoop;
  listeners: Set<AgentEventListener>;
}

/**
 * RunManager, sunucu belleğinde aktif/tamamlanmış run'ları tutar; her run için ayrı bir
 * AgentLoop örneği başlatır ve WebSocket abonelerine olayları yayınlar.
 *
 * Not: Bu basit bellek-içi implementasyon tek-instance dağıtım için yeterlidir. Yatay
 * ölçeklenme gerekirse (birden fazla backend süreci), bu katman Redis pub/sub gibi bir
 * mekanizmayla değiştirilebilir; geri kalan mimari buna bağımlı değildir.
 */
class RunManager {
  private readonly runs = new Map<string, RunRecord>();
  private readonly llmProvider = createLlmProvider();

  startRun(request: TestRunRequest): RunSummary {
    const runId = nanoid(12);
    const options = { ...defaultRunOptions, ...request.options };

    const summary: RunSummary = {
      runId,
      status: 'pending',
      url: request.url,
      scenario: request.scenario,
      startedAt: new Date().toISOString(),
      currentStep: 0,
    };

    // Yerel bir değişkende tutuyoruz (record.loop üzerinden değil): RunRecord.loop artık opsiyonel
    // (external run'lar için, bkz. registerExternalRun) — TypeScript, obje literal'inde direkt
    // atanmış olsa bile optional bir alanı `T | undefined` olarak daraltmadan bırakabiliyor.
    const loop = new AgentLoop(this.llmProvider, (event) => this.handleEvent(runId, event));
    const record: RunRecord = {
      summary,
      loop,
      listeners: new Set(),
    };
    this.runs.set(runId, record);

    summary.status = 'running';

    // Kasıtlı olarak await edilmiyor: run arka planda çalışır, ilerleme WS/poll ile takip edilir.
    void loop
      .run({
        runId,
        url: request.url,
        scenario: request.scenario,
        variables: request.variables,
        secrets: request.secrets,
        options,
      })
      .then((report) => {
        record.report = report;
        record.summary.status = report.status;
        record.summary.finishedAt = report.finishedAt;
      })
      .catch((err) => {
        log.error({ err, runId }, 'Run beklenmeyen şekilde çöktü');
        record.summary.status = 'error';
        record.summary.finishedAt = new Date().toISOString();
      });

    return summary;
  }

  getSummary(runId: string): RunSummary {
    const record = this.runs.get(runId);
    if (!record) throw new NotFoundError(`Run bulunamadı: ${runId}`);
    return record.summary;
  }

  getReport(runId: string): RunReport {
    const record = this.runs.get(runId);
    if (!record) throw new NotFoundError(`Run bulunamadı: ${runId}`);
    if (!record.report) throw new NotFoundError(`Run henüz tamamlanmadı: ${runId}`);
    return record.report;
  }

  cancelRun(runId: string): RunSummary {
    const record = this.runs.get(runId);
    if (!record) throw new NotFoundError(`Run bulunamadı: ${runId}`);
    if (!record.loop) {
      // "External" (ör. legacy) bir run — iptali kendi servisi üzerinden yapılmalı.
      throw new NotFoundError(`Bu run runManager üzerinden iptal edilemez: ${runId}`);
    }
    record.loop.cancel();
    return record.summary;
  }

  subscribe(runId: string, listener: AgentEventListener): () => void {
    const record = this.runs.get(runId);
    if (!record) throw new NotFoundError(`Run bulunamadı: ${runId}`);
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  /**
   * LegacyTestService gibi run'ı KENDİSİ başlatan (runManager.startRun() KULLANMAYAN) bir
   * çağıranın, o run'ı WS aboneleri için görünür kılmasını sağlar. runId, AgentLoop'a verilecek
   * runId ile AYNI olmalıdır ki frontend, run başlar başlamaz (henüz bitmeden) bu ID ile
   * `/ws/runs/:runId`'ye bağlanıp CANLI adım olaylarını dinleyebilsin — hâlihazırda tek bir
   * bloklayan istek olarak tasarlanmış eski frontend akışına, sözleşmeyi hiç bozmadan canlı
   * ilerleme görünürlüğü eklemenin yolu budur.
   */
  registerExternalRun(runId: string, url: string, scenario: string): void {
    if (this.runs.has(runId)) return; // idempotent — aynı runId ile iki kez çağrılırsa yok say.

    const summary: RunSummary = {
      runId,
      status: 'running',
      url,
      scenario,
      startedAt: new Date().toISOString(),
      currentStep: 0,
    };

    this.runs.set(runId, { summary, listeners: new Set() });
  }

  /** registerExternalRun() ile kaydedilmiş bir run için AgentLoop olaylarını buraya iletir. */
  publishExternalEvent(runId: string, event: AgentEvent): void {
    this.handleEvent(runId, event);
  }

  private handleEvent(runId: string, event: AgentEvent): void {
    const record = this.runs.get(runId);
    if (!record) return;

    if (event.type === 'step') {
      record.summary.currentStep = event.step.stepIndex + 1;
    }

    // startRun() ile başlatılan run'larda bu durum güncellemesi zaten .then()/.catch() ile de
    // yapılır (aynı değerlerle) — burada da yapmak, registerExternalRun() ile kaydedilen run'lar
    // için TEK doğru güncelleme yolu olduğundan gereklidir; ikisi çakışmaz (idempotent).
    if (event.type === 'run_finished') {
      record.summary.status = event.status;
      record.summary.finishedAt = event.report.finishedAt;
    }
    if (event.type === 'run_error') {
      record.summary.status = 'error';
      record.summary.finishedAt = new Date().toISOString();
    }

    for (const listener of record.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn({ err, runId }, 'Event listener hata fırlattı');
      }
    }
  }
}

export const runManager = new RunManager();
