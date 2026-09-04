import path from 'node:path';
import { nanoid } from 'nanoid';
import type { ReplayStep, RunArtifacts, RunOptions, RunReport } from '../../domain/types.js';
import type {
  BatchRunStartResult,
  CallerContext,
  GeneratedTestSchedule,
  LegacyGenerateAndRunInput,
  LegacyGeneratedTestMeta,
  LegacyRunExistingOverrides,
  LegacyScheduleOnlyInput,
  LegacyRunRecord,
  LegacySuite,
  LegacyTestResultResponse,
} from '../../domain/legacyTypes.js';
import { AgentLoop } from '../agent/AgentLoop.js';
import type { LlmProvider } from '../llm/LlmProvider.js';
import { defaultRunOptions } from '../../config/env.js';
import { synthesizeTestCode } from './codeSynthesizer.js';
import { buildBddSteps } from './buildBddSteps.js';
import { TestRunStore } from './TestRunStore.js';
import { GeneratedTestStore, buildGeneratedFileName } from './GeneratedTestStore.js';
import { SuiteStore } from './SuiteStore.js';
import { applySchedule } from './TestScheduler.js';
import { AllureReportService } from './AllureReportService.js';
import { createScenario } from '../../db/scenarioStore.js';
import { createRun, deleteRunsBefore, deleteRunByFinishedAt, deleteAllRuns } from '../../db/runStore.js';
import { NotFoundError, ValidationError } from '../../domain/errors.js';
import { createLogger } from '../../config/logger.js';
import { runManager } from '../../api/runManager.js';
import { encryptTestSecret, decryptTestSecret } from '../../auth/secretCrypto.js';

const log = createLogger('LegacyTestService');

/**
 * WEB_SCENARIOS.SCENARIO_NAME Oracle'da VARCHAR2(200 BYTE) — yani sinir KARAKTER degil BYTE
 * (UTF-8). Turkce karakterler (ç, ş, ğ, ı, ö, ü, İ) UTF-8'de 2 byte tuttugu icin JS'in
 * `.slice(0, 200)`'u (UTF-16 kod birimi/karakter sayar) 200 KARAKTERLIK bir string uretebilir
 * ama bu string 200 byte'i asabilir (ör. ORA-12899 'actual: 224, maximum: 200') — INSERT o an
 * hata verir. Bu fonksiyon byte sinirina gore, cok-byte'li bir karakteri ORTADAN BOLMEDEN
 * kirpar (surrogate-pair guvenli: Array.from ile Unicode code point'lere ayirir).
 */
function truncateToUtf8ByteLength(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }
  let result = '';
  let bytes = 0;
  for (const char of Array.from(value)) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) {
      break;
    }
    result += char;
    bytes += charBytes;
  }
  return result;
}

/**
 * v3.20 — bkz. LegacyGeneratedTestMeta.secretsEncrypted dosya basi aciklamasi. Saklanan
 * secret'lari calistirma aninda coz. Bozuk/eski-anahtarli bir degerle karsilasilirsa
 * (decryptTestSecret null doner) SADECE o secret'i atlar ve loglar -- tum run'i BASARISIZ
 * KILMAZ (o secret'a gercekten ihtiyac duyan bir adim varsa AgentLoop zaten
 * findUnknownReferences ile 'tanimsiz referans' hatasiyla guvenli durur).
 */
function decryptStoredSecrets(
  encrypted: Record<string, string> | undefined,
  fileName: string,
): Record<string, string> | undefined {
  if (!encrypted || Object.keys(encrypted).length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(encrypted)) {
    const decrypted = decryptTestSecret(value);
    if (decrypted === null) {
      log.warn({ fileName, secretName: name }, 'Kayitli secret cozulemedi (anahtar degismis olabilir), atlaniyor');
      continue;
    }
    result[name] = decrypted;
  }
  return result;
}

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
  private readonly suiteStore = new SuiteStore();
  private readonly allureReportService = new AllureReportService();
  private activeLoop: AgentLoop | null = null;
  // Frontend'in POST /api/tests/generate-and-run bloklayan isteği HENÜZ sonuçlanmadan (test daha
  // bitmeden) bu runId'yi öğrenip `/ws/runs/:runId`'ye bağlanabilmesi için — bkz. getActiveRunId().
  private activeRunId: string | null = null;

  constructor(private readonly llmProvider: LlmProvider) {}

  async generateAndRun(
    input: LegacyGenerateAndRunInput,
    // v3.0 Faz 6 — SADECE Oracle'a (best-effort) yazarken WEB_SCENARIOS/WEB_RUNS.CREATED_BY/STARTED_BY
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
        // v3.20'den beri finalizeResult bunları şifreleyip meta.secretsEncrypted'e de yazıyor
        // (bkz. o alanın dosya başı açıklaması) — burada LLM'e/loglara gitmeyeceği hâlâ geçerli.
        secrets: input.secrets,
        options,
      });
    } catch (err) {
      // v3.22 — bkz. sohbet notu: "koşum hata alsa dahi o bilgileri getirsin". loop.run()
      // BEKLENMEDİK şekilde (crash — ör. tarayıcı başlatılamadı, ağ hatası; normal 'finish_failure'
      // İŞ MANTIĞI sonucu DEĞİL) fırlatırsa, ÖNCEDEN bu deneme için HİÇBİR ŞEY (url/scenario/
      // variables) kalıcı olmuyordu — kullanıcı bu denemeyi Generated Tests'te asla bulamıyordu.
      // Elimizdeki (crash'ten ÖNCE bilinen) bilgilerle best-effort bir kayıt oluşturup orijinal
      // hatayı YİNE DE fırlatıyoruz — route hâlâ 500 döner (bkz. dosya başı NOT: SADECE gerçek
      // sistem hatalarında böyle davranılması BİLİNÇLİ), sadece artık veri KAYBOLMUYOR.
      await this.persistCrashedAttempt(
        runId,
        input.url,
        input.scenario,
        input.variables,
        options,
        startedAtMs,
        errorMessage(err, 'Beklenmeyen bir hata oluştu.'),
        input.testName,
        input.projectId,
        actingUserId,
        input.secrets,
      ).catch((persistErr) => {
        log.error({ persistErr, runId }, 'Çöken run için best-effort kayıt da başarısız oldu');
      });
      throw err;
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
      input.secrets,
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

  /**
   * v3.4 — bkz. sohbet notu: "test runs kısmından sile bastığımızda databaseden de siliyor mu".
   * ÖNCEDEN sadece JSON tarafını (index.json + detay/artefakt dosyaları) siliyordu; Oracle
   * WEB_RUNS'ta karşılığı varsa (best-effort yazılmışsa) orada SONSUZA kadar kalıyordu. Şimdi
   * silinen kaydın `createdAt`/`ownerId` bilgisiyle (bkz. TestRunStore.delete dosya başı NOT'u)
   * WEB_RUNS'taki karşılığı da (varsa) best-effort silinmeye çalışılıyor — clearTestRunsBefore ile
   * AYNI desen: JSON tarafı asıl kaynak-of-truth'tur, Oracle hatası yanıtı ASLA etkilemez.
   */
  async deleteTestRun(id: string, caller: CallerContext): Promise<{ id: string }> {
    await this.assertRunAccess(id, caller);
    const deleted = await this.testRunStore.delete(id);

    try {
      await deleteRunByFinishedAt(new Date(deleted.createdAt), deleted.ownerId ?? null);
    } catch (err) {
      log.error({ err, id }, 'Koşum Oracle veritabanından silinemedi (JSON tarafı yine de başarılı)');
    }

    return { id };
  }

  async clearTestRuns(caller: CallerContext): Promise<{ count: number }> {
    // ADMIN: predicate YOK — eski davranış (hepsini temizle) AYNEN korunur. MEMBER: sadece kendi
    // koşumlarını hedefleyen bir predicate (bkz. TestRunStore.clear() dosya başı NOT'u).
    const count =
      caller.role === 'ADMIN'
        ? await this.testRunStore.clear()
        : await this.testRunStore.clear((r) => r.ownerId === caller.userId);

    // v3.4 — bkz. deleteTestRun dosya başı NOT'u, AYNI gerekçe: "Clear All" da WEB_RUNS'ı
    // güncellemiyordu, şimdi ediyor (best-effort, JSON tarafı yine de asıl kaynak-of-truth).
    try {
      await deleteAllRuns(caller.role === 'ADMIN' ? null : caller.userId);
    } catch (err) {
      log.error({ err }, 'Tüm koşumlar Oracle veritabanından silinemedi (JSON tarafı yine de başarılı)');
    }

    return { count };
  }

  /**
   * v3.1 — Admin Panel'deki "Delete Old Runs" bakım özelliği (bkz. sohbet notu: "admin panelden
   * eski koşumları şu tarihten itibaren sil"). clearTestRuns()'ın AYNI yetki desenini kullanır
   * (ADMIN: TÜM kullanıcıların koşumları hedeflenir; MEMBER: sadece kendi koşumları — bu uç
   * pratikte SADECE Admin Panel'den, yani ADMIN rolüyle çağrılıyor, ama servis katmanında
   * clearTestRuns ile tutarlı kalması için MEMBER dalı da bilinçli olarak korundu), buna EK
   * olarak `createdAt < cutoffDate` filtresi ekler — yani "cutoffDate'TEN ESKİ (ondan önce
   * oluşturulmuş) koşumları sil" anlamına gelir; cutoffDate'in kendisi ve sonrası SİLİNMEZ.
   */
  async clearTestRunsBefore(cutoffDateIso: string, caller: CallerContext): Promise<{ count: number }> {
    const cutoff = new Date(cutoffDateIso);
    if (Number.isNaN(cutoff.getTime())) {
      throw new ValidationError('Geçersiz tarih.');
    }

    const count = await this.testRunStore.clear((r) => {
      const inScope = caller.role === 'ADMIN' || r.ownerId === caller.userId;
      return inScope && new Date(r.createdAt) < cutoff;
    });

    // v3.1 — bkz. sohbet notu: "silinenler veritabanından da siliniyor mu". WEB_RUNS (Oracle)
    // satırlarını da AYNI eşikle temizlemeyi dener — best-effort: Oracle yapılandırılmamışsa/
    // ulaşılamıyorsa bu blok SADECE loglanarak atlanır, kullanıcıya dönen `count` (JSON tarafı,
    // asıl kaynak-of-truth) ASLA etkilenmez (bkz. deleteRunsBefore dosya başı NOT'u — runStore.ts).
    try {
      await deleteRunsBefore(cutoff, caller.role === 'ADMIN' ? null : caller.userId);
    } catch (err) {
      log.error({ err }, 'Eski koşumlar Oracle veritabanından silinemedi (JSON tarafı yine de başarılı)');
    }

    return { count };
  }

  async listGeneratedTests(caller: CallerContext): Promise<{ tests: LegacyGeneratedTestMeta[] }> {
    const all = await this.generatedTestStore.list();
    // v3.20 — bkz. LegacyGeneratedTestMeta.secretsEncrypted dosya başı açıklaması. Şifreli olsa
    // bile secret ciphertext'ini frontend'e/tarayıcıya HİÇ göndermeye gerek yok (sadece backend'in
    // çözüp kullanması gerekiyor) — savunma katmanı olarak burada temizlenir. `variables` (hassas
    // DEĞİL) ile AYNI muameleyi görmez, BİLEREK.
    return {
      tests: all
        .filter((t) => isVisibleTo(t.ownerId, caller))
        .map(({ secretsEncrypted, ...rest }) => rest),
    };
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

  /**
   * v3.2 — bkz. GeneratedTestSchedule dosya başı açıklaması (legacyTypes.ts) ve TestScheduler.ts
   * dosya başı NOT'u. `schedule: null` zamanlamayı komple kaldırır. Kaydettikten SONRA
   * `applySchedule()` çağrılır — bu sayede değişiklik sunucu yeniden başlatılmadan HEMEN etkin
   * olur (ör. kullanıcı saati değiştirdiğinde eski cron job otomatik durdurulup yenisi kurulur).
   */
  async setGeneratedTestSchedule(
    fileName: string,
    schedule: GeneratedTestSchedule | null,
    caller: CallerContext,
  ): Promise<LegacyGeneratedTestMeta> {
    await this.assertGeneratedTestAccess(fileName, caller);
    const updated = await this.generatedTestStore.setSchedule(fileName, schedule);
    applySchedule(fileName, updated.schedule, () => this.runScheduledTest(fileName));
    return updated;
  }

  /* =========================================================
     SUITES — bkz. LegacySuite / LegacyGeneratedTestMeta.suiteIds dosya başı açıklamaları
     (legacyTypes.ts). Frontend, GET /generated-tests'in döndürdüğü TAM listeyi `suiteIds`'e göre
     KENDİSİ filtreler (bkz. sohbet notu: ana Generated Tests listesi vs. Suites sayfası) — burada
     ayrıca "bu suite'in testleri" için özel bir liste endpoint'i YOKTUR, gerek yoktur.
  ========================================================= */

  async listSuites(caller: CallerContext): Promise<{ suites: LegacySuite[] }> {
    const all = await this.suiteStore.list();
    return { suites: all.filter((s) => isVisibleTo(s.ownerId, caller)) };
  }

  async createSuite(name: string, actingUserId?: number | null): Promise<LegacySuite> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new ValidationError('Suite adı boş olamaz.');
    }
    // v3.11 — bkz. isVisibleTo() dosya başı NOT'u: `ownerId` YOKSA (actingUserId undefined/null)
    // suite "sahipsiz" sayılır ve SADECE admin görür — auth zaten TÜM bu router'ı koruduğundan
    // (bkz. legacyTests.ts dosya başı NOT) bu pratikte sadece savunma amaçlıdır.
    return this.suiteStore.create(trimmed, actingUserId ?? null);
  }

  /**
   * Suite kaydını siler VE bu suite'e ait olan HER testin `suiteIds` dizisinden bu id'yi çıkarır
   * (bkz. sohbet notu: "bir suite silinirse içindeki testler otomatik olarak Generated Tests
   * listesine geri dönecek" — bu, testin suiteIds'i boşalınca kendiliğinden gerçekleşir, bkz.
   * GeneratedTestStore.updateSuiteIds/removeSuiteIdFromAll dosya başı açıklamaları). Testlerin
   * KENDİSİ (dosyaları/kayıtları) SİLİNMEZ — sadece bu suite'e olan bağları kaldırılır.
   */
  async deleteSuite(id: string, caller: CallerContext): Promise<{ id: string }> {
    await this.assertSuiteAccess(id, caller);
    await this.suiteStore.delete(id);

    try {
      const affected = await this.generatedTestStore.removeSuiteIdFromAll(id);
      log.info({ suiteId: id, affected }, 'Silinen suite testlerin suiteIds listesinden temizlendi');
    } catch (err) {
      log.error({ err, suiteId: id }, 'Suite silindi ama testlerin suiteIds listesi temizlenemedi');
    }

    return { id };
  }

  /**
   * v3.11 — "Add to Suite". Bir testi bir suite'e ekler (idempotent — zaten ekliyse no-op).
   * Hem test hem suite üzerinde erişim kontrolü yapılır (ikisi de caller'a görünür olmalı).
   */
  async addTestToSuite(fileName: string, suiteId: string, caller: CallerContext): Promise<LegacyGeneratedTestMeta> {
    await this.assertGeneratedTestAccess(fileName, caller);
    await this.assertSuiteAccess(suiteId, caller);

    const meta = await this.generatedTestStore.getMeta(fileName);
    const current = new Set(meta.suiteIds ?? []);
    current.add(suiteId);

    return this.generatedTestStore.updateSuiteIds(fileName, [...current]);
  }

  /**
   * Bir testi bir suite'ten çıkarır — testin `suiteIds` dizisi bu çıkarma SONUCUNDA boşalırsa
   * (bkz. GeneratedTestStore.updateSuiteIds dosya başı NOT'u), test otomatik olarak ana Generated
   * Tests listesinde TEKRAR görünür olur.
   */
  async removeTestFromSuite(fileName: string, suiteId: string, caller: CallerContext): Promise<LegacyGeneratedTestMeta> {
    await this.assertGeneratedTestAccess(fileName, caller);

    const meta = await this.generatedTestStore.getMeta(fileName);
    const remaining = (meta.suiteIds ?? []).filter((id) => id !== suiteId);

    return this.generatedTestStore.updateSuiteIds(fileName, remaining);
  }

  /**
   * Sunucu başlangıcında (bkz. index.ts) BİR KEZ çağrılır — disk üzerindeki TÜM generated
   * testleri tarayıp `enabled: true` zamanlaması olan her biri için bir cron job kurar. Süreç
   * yeniden başladığında önceki job'lar (bellek-içi, bkz. TestScheduler.ts dosya başı NOT) zaten
   * yok olmuş olur — bu yüzden bu tarama ZORUNLUDUR, aksi halde tüm zamanlamalar sessizce
   * çalışmaz duruma düşer.
   */
  async initSchedules(): Promise<void> {
    const all = await this.generatedTestStore.list();
    const scheduled = all.filter((t) => t.schedule?.enabled);
    for (const meta of scheduled) {
      applySchedule(meta.fileName, meta.schedule, () => this.runScheduledTest(meta.fileName));
    }
    log.info({ count: scheduled.length }, 'Zamanlanmış testler yüklendi');
  }

  /**
   * v3.2 — bkz. LegacyScheduleOnlyInput dosya başı açıklaması (legacyTypes.ts) ve sohbet notu:
   * "hiç çalıştırmadan girdiğimiz senaryoyu gece çalıştırsa". `generateAndRun`'ın AKSİNE burada
   * AgentLoop HİÇ çalıştırılmaz — senaryo doğrudan bir "generated test" kaydı olarak (kod/
   * replaySteps'ten yoksun bir PLACEHOLDER olarak) diske yazılır. İlk gerçek koşum, zamanlanan
   * saatte TestScheduler -> runScheduledTest() -> runGeneratedTestsBatch() zinciriyle tetiklenir;
   * `runGeneratedTestsBatch` zaten `replaySteps` yoksa otomatik tam AI koşumuna düşer (bkz. dosya
   * başı NOT), bu yüzden burada AYRI bir tetikleme mantığına gerek YOKTUR — sadece kaydet + zamanla.
   */
  async saveScheduledScenario(
    input: LegacyScheduleOnlyInput,
    actingUserId?: number | null,
  ): Promise<LegacyGeneratedTestMeta> {
    const runId = nanoid(12);
    const trimmedTestName = input.testName?.trim();
    const fileName = buildGeneratedFileName(trimmedTestName || input.scenario, runId);
    const placeholderCode =
      `// v3.2 — bu dosya HENÜZ çalıştırılmadı; sadece zamanlanmış bir senaryo kaydıdır.\n` +
      `// İlk koşum, aşağıdaki zamanlamada TestScheduler tarafından otomatik olarak tetiklenecek.\n` +
      `// Senaryo: ${input.scenario}\n`;

    const meta: LegacyGeneratedTestMeta = {
      fileName,
      createdAt: new Date().toISOString(),
      url: input.url,
      scenario: input.scenario,
      variables: input.variables,
      browser: input.browser,
      headed: input.headed,
      screenshot: input.screenshot,
      video: input.video,
      trace: input.trace,
      useSeleniumGrid: input.useSeleniumGrid,
      // BİLİNÇLİ OLARAK yok: replaySteps/steps — bu test hiç çalıştırılmadı, henüz üretilecek bir
      // sonuç/BDD adımı yok (zaten v3.20'den beri `runGeneratedTestsBatch` replaySteps'i HİÇBİR
      // ZAMAN kullanmıyor — ilk tetiklemede de her zaman tam AI koşumu yapılacak, bkz. o metodun
      // dosya başı NOT'u).
      displayName: trimmedTestName || undefined,
      projectId: input.projectId,
      ownerId: actingUserId ?? null,
      schedule: input.schedule,
    };

    await this.generatedTestStore.save(meta, placeholderCode);
    applySchedule(fileName, input.schedule, () => this.runScheduledTest(fileName));
    return meta;
  }

  /**
   * TestScheduler'ın cron tetiklemesinde çağırdığı callback. `role: 'ADMIN'` BİLİNÇLİ OLARAK
   * kullanılır: bu bir "sistem" tetiklemesidir, gerçek bir oturum açmış kullanıcı yoktur — ADMIN
   * rolü isVisibleTo() kontrolünü her zaman geçer (bkz. dosya başı NOT), sahipsiz (ownerId: null)
   * eski testler için bile zamanlamanın çalışabilmesini sağlar. `userId` testin KENDİ sahibinden
   * (`meta.ownerId`) alınır — sadece görünürlük kontrolü İÇİN değil, ortaya çıkan Test Run
   * kaydının doğru kişiye atfedilmesi için de (bkz. runGeneratedTestsBatch -> finalizeResult
   * `actingUserId` kullanımı) — sabit bir "sistem kullanıcısı" ID'si YERİNE bu tercih edildi.
   * Test artık bulunamıyorsa (silinmiş) burada sadece loglanır; TestScheduler.applySchedule()
   * zaten onTrigger'ı try/catch ile sarmalıyor, o yüzden burada AYRICA sarmalamaya gerek yok.
   */
  private runScheduledTest(fileName: string): void {
    void this.generatedTestStore
      .getMeta(fileName)
      .then((meta) => this.runGeneratedTestsBatch([fileName], { userId: meta.ownerId ?? 0, role: 'ADMIN' }))
      .catch((err) => log.error({ err, fileName }, 'Zamanlanmış test için meta okunamadı, koşum başlatılamadı'));
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

  /** bkz. assertRunAccess() dosya başı NOT'u — AYNI mantık, suite'ler için. */
  private async assertSuiteAccess(id: string, caller: CallerContext): Promise<void> {
    if (caller.role === 'ADMIN') return;
    const suite = await this.suiteStore.getById(id);
    if (!isVisibleTo(suite.ownerId, caller)) {
      throw new NotFoundError(`Suite bulunamadı: ${id}`);
    }
  }

  /**
   * v3.20 — bkz. sohbet notu: "generated testten ve suitten testi kostugumda create testten ayni
   * senaryoyu calistirdigim gibi calismiyor ... create test'teki BDD verilerini ve Variables &
   * Secrets'daki datalari kullanacak sekilde duzenle". KÖK SEBEP (ÖNCEKİ tasarım): kayıtlı
   * `replaySteps` (bkz. ReplayStep) run'ın İLK yapıldığı andaki KONKRET/donuk değerleri (ör. bir
   * değişkenin o anki metni) taşıyordu — Variables & Secrets sonradan değişse bile replay bunu asla
   * yansıtmıyordu; secret'lar ise hiç saklanmadığından (bkz. bir alt not) replay/AI farketmeksizin
   * "tanımsız referans" ile güvenli durmaya mahkumdu. ÇÖZÜM: `replaySteps` ARTIK HİÇ kullanılmıyor
   * (bkz. AgentLoopInput.replaySteps — geçilmezse zaten tam AI moduna düşer) — Generated Tests/
   * Suites'teki "Run" da TIPKI Create Test gibi HER ZAMAN güncel BDD senaryosunu (`meta.scenario`)
   * ve güncel `meta.variables`'ı kullanarak tam AI modunda çalışır. Hız için AgentLoop zaten HER
   * adımda önce VectorCacheStore'a bakıyor (aynı domain+aksiyon için önceki bir karar varsa LLM'e
   * hiç danışmadan onu kullanıyor) — sadece cache'te yoksa VEYA cache'ten gelen karar geçersiz/
   * başarısız olursa LLM'e düşülüyor (bkz. AgentLoop tryVectorCacheHit) — yani "kayıtlı adımları
   * harfiyen tekrar oynatma" ile "her adımda LLM'e sor"un ORTASI, otomatik olarak zaten sağlanıyor.
   *
   * "Replay (No AI)" (bkz. replayGeneratedTest/`/generated-tests/replay`) BİLEREK AYRI ve
   * DEĞİŞTİRİLMEDEN bırakıldı — kullanıcının BİLEREK seçtiği, harfiyen/donuk tekrar oynatma isteyen
   * ayrı bir özellik olarak var olmaya devam ediyor.
   *
   * SECRETS — bkz. LegacyGeneratedTestMeta.secretsEncrypted dosya başı açıklaması: bu testi üreten/
   * son çalıştıran run'da kullanılan secret'lar şifreli saklanır; burada çözülüp bu çalıştırmaya da
   * (ve altta generateAndRun -> finalizeResult ile YENİ kayda da) aktarılır — zincir boyunca
   * kullanıcının secret'ları HER seferinde yeniden girmesi gerekmez.
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

    return this.generateAndRun(
      {
        url: meta.url,
        scenario: meta.scenario,
        variables: meta.variables,
        secrets: decryptStoredSecrets(meta.secretsEncrypted, fileName),
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

  /**
   * "Replay (No AI)" — daha önce PASSED ile bitmiş bir testin kayıtlı adımlarını (bkz.
   * LegacyGeneratedTestMeta.replaySteps), LLM'e HİÇ danışmadan, aynen yeniden oynatır. `generateAndRun`
   * ile AYNI "tek aktif run" bookkeeping'ini paylaşır (activeLoop/activeRunId) — aynı anda hem
   * normal bir run hem bir replay çalışamaz.
   *
   * v3.20 GÜNCELLEME — bkz. runGeneratedTest() dosya başı NOT'u: "Run" butonu ARTIK replay'i hiç
   * denemiyor, her zaman güncel BDD + Variables & Secrets ile tam AI modunda çalışıyor. Bu metod/
   * endpoint (/generated-tests/replay) buna rağmen BİLEREK KORUNDU — kullanıcının açıkça
   * "Replay (No AI)" seçtiği (bkz. app.js replayExistingTest), harfiyen/donuk tekrar oynatma
   * isteyen AYRI ve kasıtlı bir özellik olarak var olmaya devam ediyor.
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

    // v3.20 — bkz. LegacyGeneratedTestMeta.secretsEncrypted dosya başı açıklaması. Replay
    // adımlarından biri "{{secret.AD}}" placeholder'ı içeriyorsa (bkz. AgentLoop replaySteps
    // dosya başı NOT — secret DEĞERİ asla replaySteps'e yazılmaz, sadece placeholder), bu run'a
    // secrets GEÇİRİLMEZSE `findUnknownReferences` güvenli şekilde durur — bu yüzden burada da
    // aynı şekilde çözülüp geçirilir.
    const secrets = decryptStoredSecrets(meta.secretsEncrypted, fileName);

    const startedAtMs = Date.now();
    let report: RunReport;
    try {
      report = await loop.run({
        runId,
        url: meta.url,
        scenario: meta.scenario,
        variables: meta.variables,
        secrets,
        replaySteps: meta.replaySteps,
        options,
      });
    } catch (err) {
      // v3.22 — bkz. persistCrashedAttempt() dosya başı NOT'u / generateAndRun'daki AYNI blok.
      await this.persistCrashedAttempt(
        runId,
        meta.url,
        meta.scenario,
        meta.variables,
        options,
        startedAtMs,
        errorMessage(err, 'Beklenmeyen bir hata oluştu.'),
        undefined,
        meta.projectId,
        caller.userId,
        secrets,
      ).catch((persistErr) => {
        log.error({ persistErr, runId }, 'Çöken replay için best-effort kayıt da başarısız oldu');
      });
      throw err;
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
      secrets,
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
   * v3.20 GÜNCELLEME — bkz. sohbet notu: "generated testten ve suitten testi kostugumda create
   * testten ayni senaryoyu calistirdigim gibi calismiyor ... BDD verilerini ve Variables &
   * Secrets'daki datalari kullanacak sekilde duzenle". ÖNCEKİ (v2.4/v3.19) tasarım "Mümkünse
   * Replay (No AI), yoksa Run" idi — kayıtlı `replaySteps` varsa ÖNCE o denenir, sadece
   * 'replay_mismatch'/'replay_step_failed' ile başarısız olursa (v3.19'da SADECE Suites için
   * `disableAutoRetry` ile) tam AI'a düşülürdü. KÖK SORUN: `replaySteps` run'ın İLK yapıldığı
   * andaki DONUK değerleri taşıyordu (Variables & Secrets sonradan değişse replay bunu YOK
   * SAYIYORDU) ve secret'lar hiç saklanmadığından replay/AI farketmeksizin eksik secret'lı
   * senaryolar güvenli şekilde durmaya mahkumdu. ÇÖZÜM: `replaySteps` ARTIK HİÇ KULLANILMIYOR —
   * her satır HER ZAMAN güncel BDD (`meta.scenario`) + güncel `meta.variables` + saklı/çözülmüş
   * secrets ile tam AI modunda çalışır (bkz. runGeneratedTest() dosya başı NOT'u — AYNI gerekçe,
   * iki yer TUTARLI). Hız AgentLoop'un HER adımda önce VectorCacheStore'a bakması (cache'te yoksa
   * VEYA cache'ten gelen karar geçersiz/başarısız olursa LLM'e düşülür) ile zaten korunuyor.
   * `disableAutoRetry` parametresi API/şema uyumluluğu için KORUNDU ama artık ETKİSİZ — replay hiç
   * denenmediği için "replay başarısız olunca sessizce AI'a düş" senaryosu YAPISAL olarak
   * gerçekleşemiyor, `startRun()`/`startRunWithAutoRetry()` bu koşullarda AYNI şekilde davranır.
   */
  async runGeneratedTestsBatch(
    fileNames: string[],
    // v3.1 — bkz. runGeneratedTest() dosya başı NOT (aynı gerekçe).
    caller: CallerContext,
    // v3.19 — bkz. yukarıdaki v3.20 NOT'u: replay artık hiç denenmediği için bu parametre fiilen
    // etkisiz kaldı, SADECE geriye dönük API uyumluluğu için tutuldu.
    disableAutoRetry = false,
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

        // v3.20 — bkz. dosya başı NOT'u: replaySteps ARTIK hiç geçilmiyor, her zaman tam AI.
        const secrets = decryptStoredSecrets(meta.secretsEncrypted, fileName);

        const runRequest = {
          url: meta.url,
          scenario: meta.scenario,
          variables: meta.variables,
          secrets,
          options,
          replaySteps: undefined,
        };

        const summary = disableAutoRetry
          ? runManager.startRun(runRequest, caller.userId)
          : runManager.startRunWithAutoRetry(runRequest, caller.userId);

        this.persistBatchRunWhenFinished(summary.runId, meta, options, caller.userId, secrets);

        results.push({ fileName, runId: summary.runId, mode: 'run' });
      } catch (err) {
        results.push({ fileName, error: errorMessage(err, 'Test başlatılamadı.') });
      }
    }

    return results;
  }

  /**
   * runGeneratedTestsBatch() için yardımcı — bir run bittiğinde (PASS/FAIL) sonucu Test Runs/
   * Generated Tests geçmişine kalıcı hale getirir. run_finished'te normal finalizeResult ile;
   * run_error'da (beklenmeyen çökme — elde gerçek bir RunReport YOK) v3.22'den beri
   * persistCrashedAttempt() ile best-effort MINIMAL bir kayıt oluşturur (bkz. o metodun dosya
   * başı NOT'u / sohbet notu: "koşum hata alsa dahi o bilgileri getirsin") — kullanıcı çöken bir
   * Suite/Generated Tests denemesini de artık tamamen kaybetmez.
   */
  private persistBatchRunWhenFinished(
    runId: string,
    meta: LegacyGeneratedTestMeta,
    options: RunOptions,
    actingUserId?: number | null,
    // v3.20 — bkz. runGeneratedTestsBatch dosya başı NOT'u / LegacyGeneratedTestMeta.secretsEncrypted
    // açıklaması. Bu run'da kullanılan (zaten çözülmüş) secrets — finalizeResult burada YENİDEN
    // şifreleyip run'ın kendi YENİ kaydına yazar, zincir kopmaz.
    secrets?: Record<string, string>,
  ): void {
    const startedAtMs = Date.now();
    const unsubscribe = runManager.subscribe(runId, (event) => {
      if (event.type !== 'run_finished' && event.type !== 'run_error') return;
      unsubscribe();

      if (event.type === 'run_error') {
        log.warn({ runId, message: event.message }, 'Toplu çalıştırmadaki bir run beklenmeyen şekilde çöktü, best-effort kaydediliyor');
        void this.persistCrashedAttempt(
          runId,
          meta.url,
          meta.scenario,
          meta.variables,
          options,
          startedAtMs,
          event.message,
          undefined,
          meta.projectId,
          actingUserId,
          secrets,
        ).catch((persistErr) => {
          log.error({ persistErr, runId }, 'Çöken toplu çalıştırma run\'ı için best-effort kayıt da başarısız oldu');
        });
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
        secrets,
      ).catch((err) => {
        log.error({ err, runId }, 'Toplu çalıştırma sonucu geçmişe kaydedilemedi');
      });
    });
  }

  /**
   * v3.22 — bkz. sohbet notu: "kosum hata alsa dahi o bilgileri getirsin". loop.run() normal
   * bir 'finish_failure' (IS MANTIGI sonucu, RunReport ureterek doner) DEGIL de BEKLENMEDIK
   * bir sekilde firlattiginda (crash — tarayici baslatilamadi, ag hatasi, vb.) cagrilir.
   * O ana kadar bilinen url/scenario/variables ile, status:'error' olan MINIMAL bir RunReport
   * uydurup finalizeResult() uzerinden normal akisla (Generated Tests kaydi + best-effort
   * Oracle yazimi + secrets sifreleme) ayni sekilde kalici hale getirir — boylece kullanici bu
   * denemeyi HICBIR ZAMAN tamamen kaybetmez (BDD butonuyla acip duzenleyip tekrar deneyebilir).
   */
  private async persistCrashedAttempt(
    runId: string,
    url: string,
    scenario: string,
    variables: Record<string, string>,
    options: RunOptions,
    startedAtMs: number,
    failureMessage: string,
    testName?: string,
    projectId?: number,
    actingUserId?: number | null,
    secrets?: Record<string, string>,
  ): Promise<void> {
    const crashReport: RunReport = {
      runId,
      status: 'error',
      url,
      scenario,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date().toISOString(),
      totalSteps: 0,
      llmCallCount: 0,
      failureReason: failureMessage,
      steps: [],
    };
    await this.finalizeResult(
      crashReport,
      options,
      (Date.now() - startedAtMs) / 1000,
      variables,
      testName,
      projectId,
      actingUserId,
      secrets,
    );
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
    // Doluysa aşağıda WEB_SCENARIOS+WEB_RUNS'a best-effort bir Oracle yazımı da denenir.
    projectId?: number,
    actingUserId?: number | null,
    // v3.20 — bkz. LegacyGeneratedTestMeta.secretsEncrypted dosya başı açıklaması. Bu run'da
    // KULLANILAN (ister kullanıcının Create Test'te az önce girdiği, ister önceki bir kayıttan
    // çözülüp yeniden geçirilen) secret'lar — burada şifrelenip YENİ meta kaydına yazılır, böylece
    // Generated Tests/Suites'ten sonraki her tekrar çalıştırma zincir boyunca aynı secret'ları
    // kullanmaya devam edebilir.
    secrets?: Record<string, string>,
  ): Promise<LegacyTestResultResponse> {
    const status = report.status === 'passed' ? 'passed' : 'failed';
    const createdAt = report.finishedAt ?? new Date().toISOString();
    const trimmedTestName = testName?.trim();
    // Hem JSON kaydı (aşağıdaki generatedTestStore.save) hem Oracle WEB_RUNS.STEPS_JSON için TEK
    // seferde hesaplanır (bkz. BddStepView dosya başı açıklaması).
    const bddSteps = buildBddSteps(report);

    // Sentezlenen kodu + orijinal çalıştırma bağlamını diske kaydet (best-effort — başarısız
    // olursa yanıtı asla bozmaz, sadece loglanır).
    const code = synthesizeTestCode(report);
    // Kullanıcı bir isim verdiyse dosya adının slug kısmı da ONDAN türetilir (senaryo metninden
    // DEĞİL) — bu sayede hem diskteki dosya adı hem index.json kaydı baştan "düzenli" olur, sadece
    // görüntüleme katmanında bir isim eklenmiş olmaz (bkz. buildGeneratedFileName dosya başı NOT).
    const fileName = buildGeneratedFileName(trimmedTestName || report.scenario, report.runId);
    // v3.20 — bkz. finalizeResult() `secrets` parametresi / LegacyGeneratedTestMeta.secretsEncrypted
    // dosya başı açıklamaları. Boş/undefined ise `undefined` kalır (eski davranışla aynı, index.json'a
    // gereksiz boş obje yazılmaz) — sadece GERÇEKTEN kullanılan secret varsa şifrelenip saklanır.
    const secretsEncrypted =
      secrets && Object.keys(secrets).length > 0
        ? Object.fromEntries(Object.entries(secrets).map(([name, value]) => [name, encryptTestSecret(value)]))
        : undefined;
    try {
      await this.generatedTestStore.save(
        {
          fileName,
          createdAt,
          url: report.url,
          scenario: report.scenario,
          variables,
          secretsEncrypted,
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
          // v3.11 — bkz. LegacyGeneratedTestMeta.bddDescription dosya başı açıklaması.
          bddDescription: report.bddDescription,
          // v3.12 — bkz. LegacyGeneratedTestMeta.runId dosya başı açıklaması.
          runId: report.runId,
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
        const scenarioName = truncateToUtf8ByteLength(trimmedTestName || report.scenario, 200);
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

    // v3.1 — bkz. LegacyRunRecord.artifacts dosya başı açıklaması: TEK seferde hesaplanıp hem
    // kalıcı kayda (record.artifacts, aşağıda) hem de bu isteğin ANLIK yanıtına (return'deki
    // result.artifacts) aynı URL'ler yazılır — iki ayrı hesaplama/olası tutarsızlık YOK.
    const artifactUrls = toArtifactUrls(report.runId, report.artifacts);
    const hasArtifacts = Object.keys(artifactUrls).length > 0;

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
      artifacts: hasArtifacts ? artifactUrls : undefined,
      // v3.10 — bkz. LegacyRunRecord.bddDescription dosya başı açıklaması. `report.bddDescription`
      // AgentLoop.run() içinde (bkz. AgentLoop.finishRun) best-effort olarak doldurulur; üretim
      // başarısız olduysa `undefined` kalır, panel boş açılır.
      bddDescription: report.bddDescription,
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
        artifacts: artifactUrls,
      },
      // v3.10 — bkz. LegacyTestResultResponse.bddDescription/runId dosya başı açıklamaları.
      bddDescription: report.bddDescription,
      runId: report.runId,
    };
  }

  /**
   * v3.10 — "BDD" paneli: kullanıcının panelde yaptığı düzenlemeyi kaydeder. `deleteTestRun` ile
   * AYNI erişim kuralı (bkz. assertRunAccess dosya başı NOT'u) — ADMIN her koşumu düzenler, MEMBER
   * sadece kendi `ownerId`'siyle eşleşen koşumları.
   *
   * v3.12 — bkz. sohbet notu: "tıklıyım burdan bdd ye yine create test panelinde bdd kısmına
   * götürsün ordan edit yapabileyim". Asıl/kalıcı kayıt (testRunStore) güncellendikten SONRA,
   * eşleşen bir Generated Tests kaydı varsa (bkz. GeneratedTestStore.updateBddDescription dosya
   * başı NOT'u) onun görüntüleme ÖNBELLEĞİ de senkronlanır — Generated Tests/Suites sayfaları bu
   * düzenlemeyi hemen yansıtsın diye. Best-effort: senkronizasyon başarısız olursa/kayıt yoksa
   * SADECE loglanır, asıl kayıt zaten başarıyla güncellendiği için çağırana hata DÖNMEZ.
   */
  async updateBddDescription(id: string, bddDescription: string, caller: CallerContext): Promise<LegacyRunRecord> {
    await this.assertRunAccess(id, caller);
    const updated = await this.testRunStore.updateBddDescription(id, bddDescription);

    try {
      await this.generatedTestStore.updateBddDescription(updated.testFile, bddDescription);
    } catch (err) {
      log.error({ err, runId: id, fileName: updated.testFile }, 'Generated test BDD önbelleği senkronlanamadı');
    }

    return updated;
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
