import path from 'node:path';
import { nanoid } from 'nanoid';
import type { ReplayStep, RunArtifacts, RunOptions, RunReport } from '../../domain/types.js';
import type {
  BatchRunStartResult,
  CallerContext,
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
import { createScenario } from '../../db/scenarioStore.js';
import { createRun } from '../../db/runStore.js';
import { NotFoundError, ValidationError } from '../../domain/errors.js';
import { createLogger } from '../../config/logger.js';
import { runManager } from '../../api/runManager.js';

const log = createLogger('LegacyTestService');

/**
 * v3.1 — kullanıcı bazlı görünürlük kuralı (bkz. CallerContext, LegacyRunRecord.ownerId dosya
 * başı açıklamaları). Hem liste filtrelemede (`.filter(r => isVisibleTo(r.ownerId, caller))`) hem
 * TEK bir kayda erişim kontrolünde (silme/yeniden adlandırma/çalıştırma öncesi) AYNI fonksiyon
 * kullanılır — iki yerin TUTARLI kalması için tek bir yerde tutulur.
 *
 * Kural: ADMIN her şeyi görür/yönetir. MEMBER SADECE `ownerId`'si kendi `userId`'siyle eşleşen
 * kayıtlara erişebilir — `ownerId` `null`/`undefined` olan (bu alan eklenmeden ÖNCE üretilmiş
 * "sahipsiz" eski) kayıtlar MEMBER'a HİÇ gösterilmez/erişilemez, sadece ADMIN görür.
 */
function isVisibleTo(ownerId: number | null | undefined, caller: CallerContext): boolean {
  return caller.role === 'ADMIN' || (ownerId != null && ownerId === caller.userId);
}

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

  async generateAndRun(
    input: LegacyGenerateAndRunInput,
    // v3.0 Faz 6 — SADECE Oracle'a (best-effort) yazarken SCENARIOS/RUNS.CREATED_BY/STARTED_BY
    // için kullanılır (bkz. finalizeResult dosya başı NOT). JSON tabanlı akışı ETKİLEMEZ.
    actingUserId?: number | null,
  ): Promise<LegacyTestResultResponse> {
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
    runManager.registerExternalRun(runId, input.url, input.scenario, actingUserId);
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

    return this.finalizeResult(
      report,
      options,
      (Date.now() - startedAtMs) / 1000,
      input.variables,
      input.testName,
      input.projectId,
      actingUserId,
    );
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

  async listTestRuns(caller: CallerContext): Promise<{ runs: LegacyRunRecord[] }> {
    const all = await this.testRunStore.list();
    return { runs: all.filter((r) => isVisibleTo(r.ownerId, caller)) };
  }

  async deleteTestRun(id: string, caller: CallerContext): Promise<{ id: string }> {
    await this.assertRunAccess(id, caller);
    await this.testRunStore.delete(id);
    return { id };
  }

  async clearTestRuns(caller: CallerContext): Promise<{ count: number }> {
    // ADMIN: predicate YOK — eski davranış (hepsini temizle) AYNEN korunur. MEMBER: sadece kendi
    // koşumlarını hedefleyen bir predicate (bkz. TestRunStore.clear() dosya başı NOT'u).
    const count =
      caller.role === 'ADMIN'
        ? await this.testRunStore.clear()
        : await this.testRunStore.clear((r) => r.ownerId === caller.userId);
    return { count };
  }

  async listGeneratedTests(caller: CallerContext): Promise<{ tests: LegacyGeneratedTestMeta[] }> {
    const all = await this.generatedTestStore.list();
    return { tests: all.filter((t) => isVisibleTo(t.ownerId, caller)) };
  }

  async getGeneratedTestCode(fileName: string, caller: CallerContext): Promise<{ code: string; fileName: string }> {
    await this.assertGeneratedTestAccess(fileName, caller);
    const code = await this.generatedTestStore.getCode(fileName);
    return { code, fileName };
  }

  async deleteGeneratedTest(fileName: string, caller: CallerContext): Promise<{ fileName: string }> {
    await this.assertGeneratedTestAccess(fileName, caller);
    await this.generatedTestStore.delete(fileName);
    return { fileName };
  }

  /**
   * v2.4 — "senaryo ismi" düzenleme. Sadece görüntülenen ismi değiştirir (bkz.
   * LegacyGeneratedTestMeta.displayName dosya başı açıklaması) — diskteki .spec.ts dosyasının
   * gerçek adı (`fileName`, Test Runs geçmişindeki birincil anahtar) DEĞİŞMEZ.
   */
  async renameGeneratedTest(fileName: string, displayName: string, caller: CallerContext): Promise<LegacyGeneratedTestMeta> {
    await this.assertGeneratedTestAccess(fileName, caller);
    return this.generatedTestStore.rename(fileName, displayName);
  }

  async clearGeneratedTests(caller: CallerContext): Promise<{ count: number }> {
    const count =
      caller.role === 'ADMIN'
        ? await this.generatedTestStore.clear()
        : await this.generatedTestStore.clear((t) => t.ownerId === caller.userId);
    return { count };
  }

  /** bkz. isVisibleTo() dosya başı NOT'u — member kendine ait olmayan/sahipsiz bir run'a erişmeye
   * çalışırsa, kaydın varlığını ifşa etmemek için (bkz. auth.ts'teki aynı felsefe) NotFoundError
   * fırlatılır — "yetkisiz" ile "hiç yok" arasında kasıtlı olarak ayrım yapılmaz. */
  private async assertRunAccess(id: string, caller: CallerContext): Promise<void> {
    if (caller.role === 'ADMIN') return;
    const all = await this.testRunStore.list();
    const record = all.find((r) => r.id === id);
    if (!record || !isVisibleTo(record.ownerId, caller)) {
      throw new NotFoundError(`Koşum bulunamadı: ${id}`);
    }
  }

  /** bkz. assertRunAccess() dosya başı NOT'u — AYNI mantık, üretilmiş testler için. */
  private async assertGeneratedTestAccess(fileName: string, caller: CallerContext): Promise<void> {
    if (caller.role === 'ADMIN') return;
    const meta = await this.generatedTestStore.getMeta(fileName);
    if (!isVisibleTo(meta.ownerId, caller)) {
      throw new NotFoundError(`Üretilmiş test bulunamadı: ${fileName}`);
    }
  }

  /**
   * v2.4 — TEK "Run" butonu: önceden ayrı bir "Replay (No AI)" butonu vardı, kullanıcı artık
   * bunu görmüyor — karar backend'e taşındı. Kayıtlı replaySteps varsa ÖNCE onunla (hızlı, LLM
   * çağrısı yok) dener; 'replay_mismatch' (kayıtlı adım artık sayfayla eşleşmiyor) VEYA
   * 'replay_step_failed' (kayıtlı hedef hâlâ eşleşiyor ama ör. bir overlay/banner tıklamayı ANLIK
   * olarak engelledi — bkz. AgentLoop.ts "isReplay && !actionResult.ok" NOT'u) ile başarısız
   * olursa OTOMATİK olarak, AYNI runId altında, tam AI moduna geçip yeniden dener. Kayıtlı adım
   * hiç yoksa (ya da zaten tam AI'a düşüldüyse) davranış eskisiyle birebir aynıdır.
   *
   * NEDEN bu iki durumda (başka değil) AI'a geçiliyor: bkz. RunManager.startRunWithAutoRetry
   * (isRecoverableReplayFailure) dosya başı açıklaması — aynı gerekçe ve AYNI koşul burada da
   * geçerli (iki yer TUTARLI tutulmalı): ASSERTION_FAILED/loop_detected gibi başka bir başarısızlık
   * nedeni gerçek bir test/site sorunu olabilir, körü körüne tekrar denemek yanlış bir izlenim
   * verebilir — ama overlay kaynaklı geçici bir engel bu kategoriye girmez.
   */
  async runGeneratedTest(
    fileName: string,
    overrides: LegacyRunExistingOverrides,
    // v3.1 — bkz. isVisibleTo() dosya başı NOT'u. Aşağıda hem erişim kontrolü hem de (eskiden
    // actingUserId ile yapılan) Oracle CREATED_BY/STARTED_BY etiketlemesi için kullanılır.
    caller: CallerContext,
  ): Promise<LegacyTestResultResponse> {
    const meta = await this.generatedTestStore.getMeta(fileName);
    if (!isVisibleTo(meta.ownerId, caller)) {
      throw new NotFoundError(`Üretilmiş test bulunamadı: ${fileName}`);
    }
    const hasReplay = Boolean(meta.replaySteps && meta.replaySteps.length > 0);

    if (!hasReplay) {
      // Kayıtlı adım yok — tek seçenek zaten tam AI, eski davranışla birebir aynı.
      return this.generateAndRun(
        {
          url: meta.url,
          scenario: meta.scenario,
          variables: meta.variables,
          headed: overrides.headed ?? meta.headed,
          browser: overrides.browser ?? meta.browser,
          screenshot: overrides.screenshot ?? meta.screenshot,
          video: overrides.video ?? meta.video,
          trace: overrides.trace ?? meta.trace,
          useSeleniumGrid: overrides.useSeleniumGrid ?? meta.useSeleniumGrid ?? false,
          // v3.0 Faz 6 — bu testin oluşturulduğu projeyi korur (bkz. LegacyGeneratedTestMeta.projectId).
          projectId: meta.projectId,
        },
        caller.userId,
      );
    }

    if (this.activeLoop) {
      throw new ValidationError('Zaten çalışan bir test var. Önce mevcut testi durdurun.');
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

    runManager.registerExternalRun(runId, meta.url, meta.scenario, caller.userId);

    // NEDEN aynı runId'yi iki denemede de koruyoruz: `getActiveRunId()`'ı poll edip
    // `/ws/runs/:runId`'ye bağlanmış olabilecek bir istemci varsa, bağlantısını hiç değiştirmeden
    // (ikinci denemeye de) canlı adımları izlemeye devam edebilsin diye.
    const runAttempt = async (replaySteps: ReplayStep[] | undefined): Promise<RunReport> => {
      const loop = new AgentLoop(this.llmProvider, (event) => runManager.publishExternalEvent(runId, event));
      this.activeLoop = loop;
      this.activeRunId = runId;
      try {
        return await loop.run({
          runId,
          url: meta.url,
          scenario: meta.scenario,
          variables: meta.variables,
          replaySteps,
          options,
        });
      } finally {
        this.activeLoop = null;
        this.activeRunId = null;
      }
    };

    const startedAtMs = Date.now();
    let report = await runAttempt(meta.replaySteps);

    // v3.2 — AI'a düşme (fallback) koşulu GENİŞLETİLDİ: eskiden SADECE 'replay_mismatch' (kayıtlı
    // hedef elementin sayfa yapısı değişmiş) durumunda AI'a düşülüyordu; 'replay_step_failed' (ör.
    // element bulundu/eşleşti AMA bir overlay/banner tıklamayı ANLIK olarak engelledi — bkz.
    // InterceptingOverlayHandler dosya başı NOT) durumunda replay hemen pes edip kullanıcıyı elle
    // "Run (AI ile)"yi tekrar tetiklemeye zorluyordu. Oysa TAM OLARAK bu tür geçici/ortamsal
    // engeller AI modunun (adaptif DOM yeniden-taraması + overlay kurtarma) iyi olduğu senaryo —
    // canlı gözlem: hepsiburada.com'da bir replay adımı overlay yüzünden 'replay_step_failed' ile
    // başarısız oluyordu, halbuki AYNI senaryo AI moduyla normalde başarıyla tamamlanıyordu. Sadece
    // 'unknown_reference'/'loop_detected' gibi GERÇEKTEN "senaryo/sayfa bambaşka" anlamına gelen
    // durumlar bu genişletmenin DIŞINDA bırakıldı (bkz. orijinal tasarım notu: "başka bir başarısızlık
    // nedeni gerçek bir test/site sorunu olabilir" — ama TIMEOUT/ELEMENT_NOT_INTERACTABLE bu
    // kategoriye girmez, tam tersine AI modunun rutin olarak başa çıktığı bir sınıftır).
    const shouldFallbackToAi =
      report.status === 'failed' &&
      (report.failureReason?.startsWith('replay_mismatch') || report.failureReason?.startsWith('replay_step_failed'));

    if (shouldFallbackToAi) {
      log.warn(
        { fileName, runId, failureReason: report.failureReason },
        'Replay (No AI) denemesi başarısız oldu, otomatik olarak AI ile yeniden deneniyor',
      );
      runManager.publishExternalEvent(runId, {
        type: 'replay_retry_started',
        runId,
        reason: report.failureReason,
      });
      report = await runAttempt(undefined);
    }

    return this.finalizeResult(
      report,
      options,
      (Date.now() - startedAtMs) / 1000,
      meta.variables,
      undefined,
      meta.projectId,
      caller.userId,
    );
  }

  /**
   * "Replay (No AI)" — daha önce PASSED ile bitmiş bir testin kayıtlı adımlarını (bkz.
   * LegacyGeneratedTestMeta.replaySteps), LLM'e HİÇ danışmadan, aynen yeniden oynatır. `generateAndRun`
   * ile AYNI "tek aktif run" bookkeeping'ini paylaşır (activeLoop/activeRunId) — aynı anda hem
   * normal bir run hem bir replay çalışamaz.
   *
   * v2.4 NOT — frontend'de bu artık AYRI bir buton olarak GÖSTERİLMİYOR (tek "Run" butonu var,
   * bkz. runGeneratedTest() dosya başı açıklaması — o zaten replay'i otomatik önce dener). Bu
   * metod/endpoint (/generated-tests/replay) geriye dönük uyumluluk için olduğu gibi bırakıldı.
   */
  async replayGeneratedTest(
    fileName: string,
    overrides: LegacyRunExistingOverrides,
    // v3.1 — bkz. runGeneratedTest() dosya başı NOT (aynı gerekçe).
    caller: CallerContext,
  ): Promise<LegacyTestResultResponse> {
    if (this.activeLoop) {
      throw new ValidationError('Zaten çalışan bir test var. Önce mevcut testi durdurun.');
    }

    const meta = await this.generatedTestStore.getMeta(fileName);
    if (!isVisibleTo(meta.ownerId, caller)) {
      throw new NotFoundError(`Üretilmiş test bulunamadı: ${fileName}`);
    }
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

    runManager.registerExternalRun(runId, meta.url, meta.scenario, caller.userId);
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

    return this.finalizeResult(
      report,
      options,
      (Date.now() - startedAtMs) / 1000,
      meta.variables,
      undefined,
      meta.projectId,
      caller.userId,
    );
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
  async runGeneratedTestsBatch(
    fileNames: string[],
    // v3.1 — bkz. runGeneratedTest() dosya başı NOT (aynı gerekçe).
    caller: CallerContext,
  ): Promise<BatchRunStartResult[]> {
    const results: BatchRunStartResult[] = [];

    for (const fileName of fileNames) {
      try {
        const meta = await this.generatedTestStore.getMeta(fileName);
        if (!isVisibleTo(meta.ownerId, caller)) {
          throw new NotFoundError(`Üretilmiş test bulunamadı: ${fileName}`);
        }

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

        const summary = runManager.startRunWithAutoRetry(
          {
            url: meta.url,
            scenario: meta.scenario,
            variables: meta.variables,
            options,
            replaySteps: hasReplay ? meta.replaySteps : undefined,
          },
          caller.userId,
        );

        this.persistBatchRunWhenFinished(summary.runId, meta, options, caller.userId);

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
  private persistBatchRunWhenFinished(
    runId: string,
    meta: LegacyGeneratedTestMeta,
    options: RunOptions,
    actingUserId?: number | null,
  ): void {
    const startedAtMs = Date.now();
    const unsubscribe = runManager.subscribe(runId, (event) => {
      if (event.type !== 'run_finished' && event.type !== 'run_error') return;
      unsubscribe();

      if (event.type === 'run_error') {
        log.warn({ runId, message: event.message }, 'Toplu çalıştırmadaki bir run beklenmeyen şekilde çöktü, geçmişe kaydedilemiyor');
        return;
      }

      void this.finalizeResult(
        event.report,
        options,
        (Date.now() - startedAtMs) / 1000,
        meta.variables,
        undefined,
        meta.projectId,
        actingUserId,
      ).catch((err) => {
        log.error({ err, runId }, 'Toplu çalıştırma sonucu geçmişe kaydedilemedi');
      });
    });
  }

  private async finalizeResult(
    report: RunReport,
    options: RunOptions,
    durationSeconds: number,
    variables: Record<string, string>,
    // v2.4 — SADECE `generateAndRun` (yeni bir test oluştururken) verir; kullanıcının Create Test
    // sayfasında girdiği isteğe bağlı isim (bkz. LegacyGenerateAndRunInput.testName dosya başı
    // açıklaması). Var olan bir testi tekrar çalıştıran diğer çağıranlar (runGeneratedTest,
    // persistBatchRunWhenFinished) bunu BİLEREK GEÇMEZ — o testin zaten kendi kimliği/ismi vardır,
    // her tekrar çalıştırmada "düzenli" isim bilgisini rastgele bir şeyle EZMEMEK için.
    testName?: string,
    // v3.0 Faz 6 — bkz. LegacyGenerateAndRunInput.projectId / scenarioStore.ts dosya başı NOT.
    // Doluysa aşağıda SCENARIOS+RUNS'a best-effort bir Oracle yazımı da denenir.
    projectId?: number,
    actingUserId?: number | null,
  ): Promise<LegacyTestResultResponse> {
    const status = report.status === 'passed' ? 'passed' : 'failed';
    const createdAt = report.finishedAt ?? new Date().toISOString();
    const trimmedTestName = testName?.trim();
    // Hem JSON kaydı (aşağıdaki generatedTestStore.save) hem Oracle RUNS.STEPS_JSON için TEK
    // seferde hesaplanır (bkz. BddStepView dosya başı açıklaması).
    const bddSteps = buildBddSteps(report);

    // Sentezlenen kodu + orijinal çalıştırma bağlamını diske kaydet (best-effort — başarısız
    // olursa yanıtı asla bozmaz, sadece loglanır).
    const code = synthesizeTestCode(report);
    // Kullanıcı bir isim verdiyse dosya adının slug kısmı da ONDAN türetilir (senaryo metninden
    // DEĞİL) — bu sayede hem diskteki dosya adı hem index.json kaydı baştan "düzenli" olur, sadece
    // görüntüleme katmanında bir isim eklenmiş olmaz (bkz. buildGeneratedFileName dosya başı NOT).
    const fileName = buildGeneratedFileName(trimmedTestName || report.scenario, report.runId);
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
          steps: bddSteps,
          // v2.4 — bkz. LegacyGeneratedTestMeta.displayName dosya başı açıklaması. Kullanıcı isim
          // vermediyse `undefined` kalır — frontend bu durumda otomatik üretilen `fileName`'i
          // gösterir (davranış eskisiyle birebir aynı, bkz. renderGeneratedTests).
          displayName: trimmedTestName || undefined,
          // v3.0 Faz 6 — bkz. LegacyGeneratedTestMeta.projectId dosya başı açıklaması.
          projectId,
          // v3.1 — bkz. LegacyGeneratedTestMeta.ownerId / isVisibleTo() dosya başı açıklamaları.
          ownerId: actingUserId ?? null,
        },
        code,
      );
    } catch (err) {
      log.error({ err, runId: report.runId }, 'Üretilen test dosyası kaydedilemedi (yanıt yine de döndürülüyor)');
    }

    // v3.0 Faz 6 — bkz. bu metodun `projectId` parametresi dosya başı NOT'u. TAMAMEN EK ve
    // best-effort: projectId bilinmiyorsa (kullanıcı proje seçmeden test ürettiyse/eski bir testi
    // tekrar çalıştırdıysa) bu blok HİÇ ÇALIŞMAZ — "sadece bundan sonrakiler DB'ye gitsin" kararı
    // böylece doğal olarak sağlanır. Hata olursa sadece loglanır, yanıtı ASLA etkilemez (yukarıdaki
    // JSON kaydı zaten tamamlanmış olur).
    if (projectId) {
      try {
        const scenarioName = (trimmedTestName || report.scenario).slice(0, 200);
        const scenario = await createScenario({
          projectId,
          scenarioName,
          scenarioText: report.scenario,
          targetUrl: report.url,
          createdBy: actingUserId ?? null,
        });
        const finishedAtDate = new Date(createdAt);
        const startedAtDate = new Date(finishedAtDate.getTime() - durationSeconds * 1000);
        await createRun({
          scenarioId: scenario.id,
          projectId,
          status,
          browserEngine: options.browserEngine,
          startedAt: startedAtDate,
          finishedAt: finishedAtDate,
          startedBy: actingUserId ?? null,
          stepsJson: JSON.stringify(bddSteps),
        });
      } catch (err) {
        log.error(
          { err, runId: report.runId, projectId },
          'Koşum Oracle veritabanına yazılamadı (JSON kaydı yine de başarılı, yanıt etkilenmedi)',
        );
      }
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
      // v3.1 — bkz. LegacyRunRecord.ownerId / isVisibleTo() dosya başı açıklamaları.
      ownerId: actingUserId ?? null,
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
