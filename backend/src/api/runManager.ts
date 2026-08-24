import { nanoid } from 'nanoid';
import type { ReplayStep, RunReport, RunSummary, TestRunRequest } from '../domain/types.js';
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
        // Doluysa AgentLoop bunu bir "Replay (No AI)" olarak çalıştırır (bkz. TestRunRequest.replaySteps
        // dosya başı açıklaması) — v2.0 toplu/paralel çalıştırma özelliği bunu bu şekilde kullanır.
        replaySteps: request.replaySteps,
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

  /**
   * v2.4 — `runGeneratedTestsBatch()` (bkz. LegacyTestService) için: `startRun()` ile AYNI, TEK
   * fark — istek bir replay denemesiyse (replaySteps dolu) VE bu deneme özellikle
   * 'replay_mismatch' (bkz. AgentLoop "Güvenlik kapısı 3") ile başarısız olursa, bu başarısız İLK
   * denemeyi 'run_finished' olarak DIŞARI YAYINLAMAZ — bunun yerine bir 'batch_retry_started'
   * olayı yayınlayıp AYNI runId altında, replaySteps OLMADAN (tam AI) otomatik olarak İKİNCİ bir
   * deneme başlatır. Sadece bu ikinci denemenin sonucu gerçek 'run_finished' olarak yayınlanır ve
   * Test Runs/Generated Tests geçmişine kaydedilir (bkz. persistBatchRunWhenFinished — hiçbir
   * değişiklik gerekmedi, çünkü o zaten sadece 'run_finished'ı dinliyor).
   *
   * NEDEN aynı runId korunuyor: Frontend, batch API yanıtındaki runId ile HEMEN bir WS bağlantısı
   * açar (bkz. trackBatchRuns). Yeni bir runId üretip frontend'in bağlantı değiştirmesini istemek
   * yerine, mevcut bağlantı üzerinden retry akışını şeffafça sürdürüyoruz — frontend sadece yeni
   * 'batch_retry_started' olay tipini tanıyıp run'ı henüz BİTMİŞ SAYMAMASI gerektiğini bilmeli.
   *
   * NEDEN sadece 'replay_mismatch'te: Başka bir nedenle başarısız olursa (ör. TIMEOUT,
   * ASSERTION_FAILED, loop_detected) bu gerçek bir test/site sorunu olabilir — körü körüne AI ile
   * otomatik tekrar denemek yanlış bir "aslında geçti" izlenimi verebilir. SADECE replay_mismatch,
   * "kayıtlı adım artık geçersiz, AI ile adapte olarak dene" anlamına gelir.
   */
  startRunWithAutoRetry(request: TestRunRequest): RunSummary {
    const isReplayAttempt = Boolean(request.replaySteps && request.replaySteps.length > 0);
    if (!isReplayAttempt) {
      // Zaten tam AI ile başlıyor — retry mantığına gerek yok, normal startRun ile birebir aynı.
      return this.startRun(request);
    }

    const runId = nanoid(12);
    const options = { ...defaultRunOptions, ...request.options };

    const summary: RunSummary = {
      runId,
      status: 'running',
      url: request.url,
      scenario: request.scenario,
      startedAt: new Date().toISOString(),
      currentStep: 0,
    };

    const record: RunRecord = { summary, listeners: new Set() };
    this.runs.set(runId, record);

    const runAttempt = (replaySteps: ReplayStep[] | undefined, isRetryAttempt: boolean): void => {
      const loop = new AgentLoop(this.llmProvider, (event) => {
        const isReplayMismatch =
          !isRetryAttempt &&
          event.type === 'run_finished' &&
          event.status === 'failed' &&
          event.report.failureReason?.startsWith('replay_mismatch');

        if (isReplayMismatch) {
          // İlk (replay) denemenin gerçek 'run_finished'ını YAYINLAMIYORUZ — WS abonesi/geçmiş
          // kaydı bunu hiç görmeyecek, sadece nihai (AI) sonucu görecek.
          this.handleEvent(runId, {
            type: 'batch_retry_started',
            runId,
            reason: event.report.failureReason ?? 'replay_mismatch',
          });
          runAttempt(undefined, true);
          return;
        }

        this.handleEvent(runId, event);
      });
      record.loop = loop;

      void loop
        .run({
          runId,
          url: request.url,
          scenario: request.scenario,
          variables: request.variables,
          secrets: request.secrets,
          options,
          replaySteps,
        })
        .then((report) => {
          // Yukarıdaki callback ile aynı 'replay_mismatch İLK deneme' durumunda record.report/
          // summary'yi GÜNCELLEMİYORUZ (az sonra ikinci denemenin sonucuyla üzerine yazılacak) —
          // aksi halde GET /api/runs/:id gibi düz okuma yolları geçici/yanlış bir "failed" görebilir.
          const isReplayMismatch =
            !isRetryAttempt && report.status === 'failed' && report.failureReason?.startsWith('replay_mismatch');
          if (isReplayMismatch) return;

          record.report = report;
          record.summary.status = report.status;
          record.summary.finishedAt = report.finishedAt;
        })
        .catch((err) => {
          log.error({ err, runId, isRetryAttempt }, 'Run beklenmeyen şekilde çöktü');
          record.summary.status = 'error';
          record.summary.finishedAt = new Date().toISOString();
        });
    };

    runAttempt(request.replaySteps, false);
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

    // v2.2 — bkz. RunSummary.seleniumGridLiveViewUrl dosya başı açıklaması. Burada da (sadece
    // WS event'i ile değil) summary'ye yazılması, GEÇ bağlanan bir WS istemcisinin (run_snapshot
    // ile) veya WS hiç kullanmayıp sadece GET ile durumu okuyan bir çağıranın da bunu görebilmesi
    // içindir.
    if (event.type === 'grid_live_view') {
      record.summary.seleniumGridLiveViewUrl = event.url;
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
