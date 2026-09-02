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
  /**
   * v3.10 — Create Test sayfasındaki "BDD" paneli için: bu run'ın (zaten maskelenmiş) adım
   * kaydından, akıcı cümleler halinde (numaralı liste DEĞİL, klasik Given/When/And BDD kalıbı
   * DEĞİL) otomatik üretilen düz metin özet — bkz. BddDescriptionGenerator dosya başı açıklaması.
   * Üretimi best-effort'tur: LLM çağrısı başarısız olursa bu alan `undefined` kalır, panel boş
   * açılır ve kullanıcı isterse elle doldurur. Kullanıcı paneli düzenleyip kaydettiğinde
   * (PATCH /api/test-runs/:id/bdd-description) bu YANIT değil, `LegacyRunRecord.bddDescription`
   * (kalıcı kayıt) güncellenir — buradaki alan SADECE run'ın anlık, ilk yanıtındaki başlangıç
   * değeridir.
   */
  bddDescription?: string;
  /**
   * v3.10 — bkz. yukarıdaki `bddDescription` NOT'u. Frontend'in BDD panelindeki düzenlemeyi
   * KAYDEDEBİLMESİ (PATCH /api/test-runs/:id/bdd-description) için bu run'ın kimliğini taşır —
   * bu alan eklenmeden ÖNCE `LegacyTestResultResponse`'ta run'ın kendi ID'si HİÇ yoktu (`testFile`
   * bir slug'tır, birincil anahtar DEĞİLDİR). `report.runId` ile birebir aynıdır, bkz.
   * `LegacyRunRecord.id`. OPSİYONEL: bir run hiç BAŞLAMADAN (ör. istek doğrulama hatası) dönen
   * `failedResultShape()` gibi erken-çıkış yanıtlarında yoktur — bu durumda frontend BDD panelini
   * salt-okunur/kaydedilemez gösterir.
   */
  runId?: string;
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
  /**
   * v3.10 — Create Test sayfasındaki "BDD" panelinin KALICI hali (bkz.
   * LegacyTestResultResponse.bddDescription dosya başı açıklaması — orası SADECE run'ın anlık
   * yanıtındaki başlangıç değeridir). Bu run bittiğinde otomatik üretilen özetle başlar; kullanıcı
   * paneli düzenleyip kaydettiğinde (PATCH /api/test-runs/:id/bdd-description) BURASI güncellenir.
   * `undefined` ise ya üretim başarısız oldu ya da bu alan eklenmeden ÖNCE üretilmiş eski bir
   * kayıt — her iki durumda da frontend paneli boş/düzenlenebilir gösterir.
   */
  bddDescription?: string;
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
  /**
   * v3.11 — bkz. sohbet notu: "bu bdd kısmı generated test kısmında da göreceğimiz bir yer
   * olsun". `BddStepView[]` (yukarıdaki `steps`, numaralı adım listesi) ile AYNI desen: bu KAYDI
   * üreten run'ın (zaten maskelenmiş) adım kaydından akıcı cümleler halinde üretilen özet — bkz.
   * BddDescriptionGenerator, RunReport.bddDescription. `steps` ile AYNI şekilde, PASS/FAIL fark
   * etmeksizin ve SADECE bu kaydın oluşturulduğu run'a ait olarak doldurulur — `finalizeResult()`
   * her run için (yeniden çalıştırma dahil) YENİ bir fileName/kayıt ürettiğinden (bkz.
   * buildGeneratedFileName — her zaman o run'ın kendi runId'siyle benzersizdir) burada bir
   * "üzerine yazma" durumu YOKTUR; her kayıt kendi run'ının özetini taşır. Üretimi best-effort'tur:
   * LLM çağrısı başarısız olursa bu alan boş kalabilir.
   */
  bddDescription?: string;
  /**
   * v3.12 — bkz. sohbet notu: "tıklıyım burdan bdd ye yine create test panelinde bdd kısmına
   * götürsün ordan edit yapabileyim". `bddDescription` ile AYNI kayda ait, bu kaydı üreten run'ın
   * kimliği — `LegacyRunRecord.id` ile birebir aynıdır (bkz. `report.runId`). Generated Tests
   * sayfasından "BDD" tıklanıp Create Test panelindeki BDD sekmesine gidildiğinde, oradaki Save
   * butonunun hangi run kaydına (`PATCH /api/test-runs/:id/bdd-description`) yazacağını bilmesi
   * İÇİN gerekli — bu alan olmadan panel metni GÖSTERİLEBİLİR ama KAYDEDİLEMEZ. OPSİYONEL: bu alan
   * eklenmeden ÖNCE üretilmiş eski kayıtlarda bulunmaz — bu durumda frontend paneli salt-okunur
   * (Save "run kimliği yok" der) gösterir, `bddDescription` ile AYNI eski-kayıt davranışı.
   */
  runId?: string;
  /**
   * v3.11 — bkz. LegacySuite dosya başı açıklaması. Bu testin AİT OLDUĞU suite'lerin id listesi —
   * bir test AYNI ANDA birden fazla suite'e ait olabilir (bkz. sohbet notu: "Ayni test birden
   * fazla suite'e eklenebilsin"). Bu dizi BOŞ DEĞİLKEN (en az bir suite'e eklenmişken) test ana
   * Generated Tests listesinden GİZLENİR — SADECE ait olduğu suite(ler)in Suites sayfasındaki
   * görünümünde yer alır (bkz. sohbet notu: "Sadece Suit'te görünür, Generated Tests'ten
   * kaybolur"). OPSİYONEL/boş dizi: bu alan eklenmeden ÖNCE üretilmiş eski kayıtlarda yoktur —
   * `undefined`/boş dizi "hiçbir suite'e ait değil, Generated Tests'te görünür" anlamına gelir.
   */
  suiteIds?: string[];
}

/**
 * v3.11 — "Suites" paneli (bkz. sohbet notu: "Suit adında bir panel daha yapacağız... dashboardın
 * altında yer alsın"). Bir suite SADECE bir isim ve kimlikten ibarettir — HANGİ testlerin bu
 * suite'e ait olduğu, suite kaydının kendisinde DEĞİL, her `LegacyGeneratedTestMeta.suiteIds`
 * alanında tutulur (bkz. o alanın dosya başı açıklaması) — bu sayede bir suite silindiğinde
 * (bkz. LegacyTestService.deleteSuite) sadece bu tek kaydın silinip her testin `suiteIds`
 * dizisinden bu id'nin çıkarılması yeterlidir, ayrı bir "üyelik listesi" senkron tutulmaz.
 */
export interface LegacySuite {
  id: string;
  name: string;
  createdAt: string;
  /**
   * v3.11 — bkz. CallerContext / LegacyRunRecord.ownerId / isVisibleTo() dosya başı açıklamaları
   * — AYNI kullanıcı-bazlı görünürlük kuralı burada da geçerlidir: ADMIN her suite'i görür/yönetir,
   * MEMBER sadece kendi oluşturduğu suite'lere erişebilir. Bu, projedeki diğer TÜM legacy
   * kayıtlarla (Test Runs, Generated Tests) TUTARLI kalmak için bilinçli bir seçimdir — "regresyon
   * suite'i" kavramsal olarak takım-genelinde paylaşılabilir bir şey gibi görünse de, mevcut
   * mimaride paylaşılan/takım-genelinde görünür bir kayıt türü YOKTUR; bu davranış istenmezse
   * (ör. suite'lerin TÜM MEMBER'lara görünür olması) ayrıca belirtilmelidir.
   */
  ownerId?: number | null;
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
