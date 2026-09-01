import type { ActionType, BrowserEngine, ReplayStep } from './types.js';

/**
 * Bu dosya, mevcut (korunan) frontend'in beklediği eski API sözleşmesine ait tipleri içerir.
 * Bunlar platformun kendi generic modelinden (types.ts) BİLEREK ayrı tutulmuştur: burası bir
 * uyum (adapter) katmanının sözleşmesidir, çekirdek mimarinin bir parçası değildir.
 */

export type LegacyStatus = 'passed' | 'failed';

/**
 * v3.1 — kullanıcı bazlı görünürlük (Test Runs/Generated Tests/Projects sayfaları): her isteğin
 * kimin adına yapıldığını taşır. `role === 'ADMIN'` olan her şeyi görür/yönetir; `MEMBER` sadece
 * kendi `ownerId`'siyle etiketlenmiş kayıtlara erişebilir. Bu, requireAuth middleware'inin zaten
 * doldurduğu `req.authUser`'dan (userId + role) birebir türetilir — bkz. legacyTests.ts NOT'u.
 */
export interface CallerContext {
  userId: number;
  role: 'ADMIN' | 'MEMBER';
}

/** Frontend'in "Generate & Run" / "Run existing test" çağrılarından beklediği yanıt şekli. */
export interface LegacyTestResultResponse {
  generatedCode: string;
  testFile: string;
  status: LegacyStatus;
  message: string;
  result: {
    output: string;
    errorOutput: string;
    exitCode: number;
    artifacts: {
      screenshot?: string;
      video?: string;
      trace?: string;
    };
  };
}

/** GET /api/test-runs listesindeki tek bir kayıt. */
export interface LegacyRunRecord {
  id: string;
  testFile: string;
  status: LegacyStatus;
  browser: BrowserEngine;
  duration: number;
  createdAt: string;
  message?: string;
  error?: string;
  errorOutput?: string;
  exitCode: number;
  /**
   * v3.1 — bu koşumu başlatan kullanıcının USER_ID'si (bkz. CallerContext, LegacyTestService
   * finalizeResult). OPSİYONEL: bu alan eklenmeden ÖNCE üretilmiş eski kayıtlarda bulunmaz —
   * bu durumda kayıt "sahipsiz" sayılır ve SADECE admin rolündeki kullanıcılara gösterilir (bkz.
   * LegacyTestService.isVisibleTo dosya başı NOT'u).
   */
  ownerId?: number | null;
  /**
   * v3.1 — bkz. sohbet notu: "test koşumlarında alınan ekran görüntüleri test runs da... gözüksün".
   * ÖNCEDEN sadece run'ın ANLIK HTTP yanıtında (LegacyTestResultResponse.result.artifacts) vardı —
   * Create Test sayfasından ayrılınca kaybolurdu, Test Runs (GEÇMİŞ koşumlar) listesinde HİÇ
   * görünmüyordu. Artık AYNI URL'ler (bkz. LegacyTestService.toArtifactUrls — `/artifacts/<runId>/
   * ...`, backend'de auth GEREKTİRMEDEN statik servis edilir, bkz. app.ts) bu kayda da yazılıp
   * kalıcı hale getiriliyor. Tamamı OPSİYONEL: bir run screenshot/video/trace İSTEMEDEN
   * çalıştırıldıysa (ör. captureScreenshot=false) ilgili alan hiç yazılmaz.
   */
  artifacts?: {
    screenshot?: string;
    video?: string;
    trace?: string;
  };
}

/**
 * BDD-stil (Given/When/Then benzeri) gösterim için, bir run'ın TEK bir adımının insan-okunur
 * özeti — bkz. buildBddSteps.ts. `replaySteps`'ten (ReplayStep) BİLEREK ayrıdır: replaySteps
 * yürütme amaçlı minimal bir veridir (sadece PASSED run'larda dolar), bu ise SADECE görüntüleme
 * amaçlıdır ve PASS/FAIL fark etmeksizin her run için üretilir (kullanıcı, başarısız bir
 * senaryonun da hangi adımda nerede durduğunu görebilsin diye).
 */
export interface BddStepView {
  index: number;
  action: ActionType;
  /** AI'nın bu adım için verdiği doğal dil gerekçesi (ör. "Arama kutusuna 'kablosuz kulaklık' yazıldı"). */
  description: string;
  ok: boolean;
  /**
   * v3.1 — bu adımın kararı NEREDEN geldi (bkz. AgentDecision.decisionSource dosya başı NOT'u):
   * 'llm' gerçek bir model çağrısı, 'vector_cache' geçmiş benzer bir karardan LLM'e HİÇ
   * danışılmadan yeniden kullanıldı, 'replay' kullanıcının "Replay (No AI)" ile kaydedilmiş bir
   * adımı yeniden oynatması. Sohbet notu: "execution logta vector db den mi yoksa llmden mi onu
   * da görelim" — kullanıcı her adımın gerçek bir AI kararı mı yoksa önbellekten mi geldiğini
   * ayırt edebilsin diye eklendi. Eski (bu alan eklenmeden ÖNCE üretilmiş) kayıtlarda bulunmaz.
   */
  decisionSource?: 'llm' | 'vector_cache' | 'replay';
}

/**
 * v3.2 — bir generated test'in gece/otomatik koşum zamanlaması (bkz. sohbet notu: "gece test
 * koşumu yapabilmemiz için zamanlayıcı"). `time` 24 saatlik "HH:MM" formatındadır (yerel sunucu
 * saatine göre yorumlanır — bkz. TestScheduler.ts dosya başı NOT); `days` 0 (Pazar) - 6 (Cumartesi)
 * arası, cron'un gün-of-week alanıyla AYNI sayı sistemi, en az bir gün içermelidir. `enabled: false`
 * iken TestScheduler bu kayıt için hiçbir cron job KURMAZ — kullanıcı zamanlamayı silmeden geçici
 * olarak kapatabilsin diye (ör. "bu hafta çalıştırma ama ayarları kaybetme") `enabled` alanı BİLİNÇLİ
 * OLARAK schedule'ı komple silmekten (`schedule: undefined`) ayrı tutuldu.
 */
export interface GeneratedTestSchedule {
  enabled: boolean;
  time: string;
  days: number[];
}

/** GET /api/generated-tests listesindeki + index.json'da saklanan tek bir kayıt. */
export interface LegacyGeneratedTestMeta {
  fileName: string;
  createdAt: string;
  url: string;
  scenario: string;
  variables: Record<string, string>;
  browser: BrowserEngine;
  headed: boolean;
  screenshot: boolean;
  video: boolean;
  trace: boolean;
  /**
   * v2.0 — bu testin Selenium Grid üzerinden mi (true) yoksa yerel bir tarayıcıyla mı (false/
   * tanımsız) çalıştırıldığı/çalıştırılacağı (bkz. RunOptions.useSeleniumGrid dosya başı
   * açıklaması). OPSİYONEL: bu alan eklenmeden ÖNCE üretilmiş eski kayıtlarda bulunmaz — bu
   * durumda `false` (yerel) varsayılır (bkz. LegacyTestService'teki `?? false` kullanımı).
   */
  useSeleniumGrid?: boolean;
  /**
   * SADECE bu testi üreten run PASSED ile bittiyse doldurulur — "Replay (No AI)" ile bu testin
   * LLM'e hiç danışılmadan tekrar oynatılabilmesini sağlar (bkz. ReplayStep, AgentLoop.replaySteps).
   * Secret DEĞERİ İÇERMEZ (bkz. ReplayStep dosya başı açıklaması) — diske yazılması güvenlidir.
   */
  replaySteps?: ReplayStep[];
  /**
   * BDD/step bazlı görüntüleme için (bkz. BddStepView) — PASS/FAIL fark etmeksizin doldurulur.
   * Eski (bu alan eklenmeden ÖNCE üretilmiş) kayıtlarda bulunmaz; frontend bu durumda step
   * listesini/genişletme okunu göstermemelidir (bkz. generated-tests.html render mantığı).
   */
  steps?: BddStepView[];
  /**
   * v2.4 — kullanıcının bu teste verdiği isteğe bağlı, insan tarafından okunabilir özel isim
   * (bkz. GeneratedTestStore.rename). BİLEREK `fileName`'den AYRI tutulur: `fileName` diskteki
   * gerçek .spec.ts dosyasının adı VE Test Runs geçmişindeki (`LegacyRunRecord.testFile`) birincil
   * anahtardır — bunu değiştirmek geçmiş koşum kayıtlarını "yetim" bırakırdı. `displayName` SADECE
   * görüntüleme amaçlıdır; boşsa frontend `fileName`'i (otomatik üretilen slug) göstermeye devam
   * eder (bkz. renderGeneratedTests dosya başı NOT).
   */
  displayName?: string;
  /**
   * v3.0 Faz 6 — bu testin hangi WEB_PROJECTS kaydına ait olduğu (bkz. sohbet notu: "onlar da db ye
   * kaydolması lazım" → Create Test sayfasına proje seçici eklendi). OPSİYONEL: bu alan
   * eklenmeden ÖNCE üretilmiş eski kayıtlarda bulunmaz VE kullanıcı proje seçmeden de test
   * üretebilir/çalıştırabilir (JSON tabanlı akış projeden bağımsız çalışmaya devam eder) —
   * SADECE doluysa LegacyTestService.finalizeResult() Oracle'a da (best-effort) yazar, çünkü
   * WEB_SCENARIOS.PROJECT_ID veritabanında NOT NULL'dur.
   */
  projectId?: number;
  /**
   * v3.1 — bu testi üreten koşumu başlatan kullanıcının USER_ID'si (bkz. CallerContext,
   * LegacyRunRecord.ownerId dosya başı açıklaması — AYNI mantık burada da geçerli). OPSİYONEL:
   * bu alan eklenmeden ÖNCE üretilmiş eski kayıtlarda bulunmaz — "sahipsiz" sayılır, SADECE admin
   * görür.
   */
  ownerId?: number | null;
  /** v3.2 — bkz. GeneratedTestSchedule dosya başı açıklaması. OPSİYONEL: hiç zamanlanmamış bir
   * testte bu alan hiç yoktur (frontend'de "Zamanlanmadı" olarak gösterilir). */
  schedule?: GeneratedTestSchedule;
}

/**
 * POST /api/generated-tests/run-batch yanıtındaki TEK bir öğe. Diğer legacy endpoint'lerin aksine
 * (bkz. dosya başı NOT — "her zaman HTTP 200 + status:'failed'" sözleşmesi) bu endpoint YENİ bir
 * yüzeydir ve eski frontend'in beklediği bir sözleşmeye bağlı değildir: her run RunManager
 * üzerinden ASENKRON (bloklamadan) başlatılır, bu yüzden yanıt sonucu değil sadece "başlatıldı mı"
 * bilgisini taşır — asıl PASS/FAIL sonucu `runId` ile `/ws/runs/:runId` üzerinden takip edilir.
 */
export interface BatchRunStartResult {
  fileName: string;
  /** Başarıyla başlatıldıysa dolu — canlı takip için `/ws/runs/:runId`'ye bağlanılabilir. */
  runId?: string;
  /** Bu test için kayıtlı replaySteps varsa 'replay' (AI'sız, token harcamaz), yoksa 'run' (AI'lı). */
  mode?: 'replay' | 'run';
  /** Başlatılamadıysa (ör. dosya artık mevcut değil) dolu, `runId`/`mode` bu durumda yoktur. */
  error?: string;
}

export interface LegacyGenerateAndRunInput {
  url: string;
  scenario: string;
  /**
   * v2.4 — kullanıcının Create Test sayfasında verdiği isteğe bağlı, insan tarafından okunabilir
   * isim (bkz. create-test.html "TEST NAME" NOT). Doluysa hem `LegacyGeneratedTestMeta.displayName`
   * hem de üretilecek dosya adının slug kısmı için kullanılır (bkz. LegacyTestService.finalizeResult
   * dosya başı açıklaması) — boşsa davranış eskisiyle birebir aynıdır (senaryo metninden otomatik
   * slug + rastgele id).
   */
  testName?: string;
  headed: boolean;
  browser: BrowserEngine;
  screenshot: boolean;
  video: boolean;
  trace: boolean;
  /** v2.0 — bkz. RunOptions.useSeleniumGrid dosya başı açıklaması (SADECE browser "chromium" iken geçerli). */
  useSeleniumGrid: boolean;
  variables: Record<string, string>;
  /**
   * Hassas değerler (şifre, token vb.). `variables`'tan BİLEREK ayrı tutulur: AgentLoop/SecretsVault
   * bunları LLM'e/loglara asla düz metin göndermez (bkz. SecretsVault dosya başı açıklaması).
   * ÖNEMLİ: bu alan BİLEREK `LegacyGeneratedTestMeta`'ya (diske kaydedilen index.json) dahil
   * EDİLMEZ — secret değerleri hiçbir zaman diske yazılmaz; bir "generated test"i secrets ile
   * tekrar çalıştırmak isteyen kullanıcı bunları her seferinde yeniden girmelidir.
   */
  secrets?: Record<string, string>;
  /** v3.0 Faz 6 — bkz. LegacyGeneratedTestMeta.projectId dosya başı açıklaması. OPSİYONEL. */
  projectId?: number;
}

/**
 * v3.2 — bkz. sohbet notu: "hiç çalıştırmadan girdiğimiz senaryoyu gece çalıştırsa". POST
 * /generated-tests/schedule-only gövdesi. `LegacyGenerateAndRunInput`'un neredeyse birebir aynısı,
 * SADECE İKİ farkla: `secrets` alanı hiç YOK (bkz. LegacyTestService.saveScheduledScenario dosya
 * başı açıklaması — SecretsVault hiçbir zaman diske yazmaz, bu yüzden kimsenin izlemediği bir
 * gece koşumunda secret KULLANILAMAZ) ve `schedule` ZORUNLUDUR (bu uç bir zamanlama OLMADAN
 * anlamsızdır — zamanlamasız kayıt için zaten `generateAndRun` + ayrı PUT .../schedule akışı var).
 */
export interface LegacyScheduleOnlyInput {
  url: string;
  scenario: string;
  testName?: string;
  headed: boolean;
  browser: BrowserEngine;
  screenshot: boolean;
  video: boolean;
  trace: boolean;
  useSeleniumGrid: boolean;
  variables: Record<string, string>;
  projectId?: number;
  schedule: GeneratedTestSchedule;
}

export interface LegacyRunExistingOverrides {
  headed?: boolean;
  browser?: BrowserEngine;
  screenshot?: boolean;
  video?: boolean;
  trace?: boolean;
  /** v2.0 — bkz. RunOptions.useSeleniumGrid dosya başı açıklaması. */
  useSeleniumGrid?: boolean;
}
