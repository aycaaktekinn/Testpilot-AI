/**
 * Domain tipleri - platformun tüm katmanlarında paylaşılan çekirdek modeller.
 * Bu dosya tek bir siteye/uygulamaya özel HİÇBİR şey içermez; tamamen generic'tir.
 */

/** Kullanıcının test çalıştırmak istediği talep. */
export interface TestRunRequest {
  /** Test edilecek web sitesinin başlangıç URL'i. */
  url: string;
  /** Doğal dilde test senaryosu (Türkçe veya İngilizce olabilir). */
  scenario: string;
  /** Gizli olmayan değişkenler (örn. { "aramaTerimi": "laptop" }). Prompt'a ve loglara açık gidebilir. */
  variables?: Record<string, string>;
  /** Hassas değerler (örn. şifreler, API anahtarları). Değerleri LLM'e ve loglara ASLA gönderilmez. */
  secrets?: Record<string, string>;
  /** Çalıştırma seçenekleri. */
  options?: Partial<RunOptions>;
}

export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

export interface RunOptions {
  maxSteps: number;
  headless: boolean;
  stepTimeoutMs: number;
  navigationTimeoutMs: number;
  defaultActionTimeoutMs: number;
  maxElementsPerStep: number;
  maxRepeatedActions: number;
  minConfidence: number;
  viewport: { width: number; height: number };
  /** Hangi tarayıcı motoruyla çalıştırılacağı. */
  browserEngine: BrowserEngine;
  /** Run sonunda tam sayfa ekran görüntüsü alınsın mı. */
  captureScreenshot: boolean;
  /** Run boyunca video kaydı yapılsın mı (Playwright'ın recordVideo özelliği). */
  captureVideo: boolean;
  /** Run boyunca Playwright trace (screenshots+snapshots) toplanıp .zip olarak kaydedilsin mi. */
  captureTrace: boolean;
}

/** Bir run sonunda üretilen (varsa) dosya tabanlı kanıtlar. Değerler mutlak dosya sistemi yoludur. */
export interface RunArtifacts {
  screenshotPath?: string;
  videoPath?: string;
  tracePath?: string;
}

export type RunStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'error'
  | 'cancelled';

/**
 * LLM'in bir adımda seçebileceği aksiyon türleri.
 * Tek kaynak (single source of truth) burasıdır; zod şeması (actionSchema.ts) bu diziden türetilir,
 * böylece iki tanım birbirinden asla sapmaz.
 */
export const ACTION_TYPES = [
  'click',
  'dblclick',
  'fill',
  'type',
  'press_key',
  'select_option',
  'check',
  'uncheck',
  'hover',
  'scroll_into_view',
  'navigate',
  'go_back',
  'wait',
  'assert_visible',
  'assert_text',
  'assert_url',
  'finish_success',
  'finish_failure',
  'ask_clarification',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * LLM'den beklenen ham karar çıktısı (JSON). Bu, PromptBuilder tarafından
 * istenen ve ResponseParser tarafından zod ile doğrulanan şemadır.
 */
export interface AgentDecision {
  /** Kısa gerekçe (loglanır, kullanıcıya gösterilir). Asla secret değeri içermemeli. */
  reasoning: string;
  /** 0-1 arası, modelin bu karara olan güveni. */
  confidence: number;
  /** Seçilen aksiyon. */
  action: ActionType;
  /** DOM analizinde verilen element referansı (örn. "e12"). Element gerektirmeyen aksiyonlarda boş olabilir. */
  targetRef?: string;
  /**
   * Aksiyonun değeri. fill/type için girilecek metin, select_option için seçenek değeri,
   * navigate için URL, wait için ms, assert_text için beklenen metin, press_key için tuş adı olabilir.
   * Secret referansları "{{secret.AD}}" biçiminde placeholder olarak verilir; gerçek değer asla burada olmaz.
   */
  value?: string;
  /** Senaryonun tamamlandığını veya başarısız olduğunu düşünüyorsa kısa özet. */
  summary?: string;
}

/** DOM analizinde keşfedilen tek bir etkileşilebilir element. */
export interface DiscoveredElement {
  /** Kararlı, çalışma süresi boyunca geçerli kısa referans (örn. "e1"). */
  ref: string;
  tag: string;
  role: string | null;
  accessibleName: string | null;
  text: string | null;
  attributes: Record<string, string>;
  /** Görünür ve etkileşilebilir mi (viewport, disabled, visibility kontrolleri sonrası). */
  visible: boolean;
  enabled: boolean;
  /** Element hangi frame içinde bulundu (ana sayfa için "main"). */
  frame: string;
  /** input/textarea için mevcut değer (varsa), fazla uzun ise kısaltılır. */
  currentValue?: string;
  /**
   * SADECE <select> elementleri için: tüm <option>'ların görünen metinleri (üst sınırlı). LLM'in
   * select_option aksiyonu için geçerli bir "value" (Playwright'ın GÖRÜNEN metinle eşleştirdiği,
   * bkz. ActionExecutor.select_option) yazabilmesi için hangi seçeneklerin var olduğunu bilmesi
   * gerekir — bkz. browserDiscoveryScript.ts'teki dosya başı NOT (hepsiburada.com "sırala"
   * dropdown'ı regresyonu).
   */
  options?: string[];
}

/** Bir DOM analiz anının (snapshot) LLM'e sunulan özet hali. */
export interface PageSnapshot {
  url: string;
  title: string;
  elements: DiscoveredElement[];
  /** Toplam keşfedilen element sayısı (kesme uygulanmadan önce), telemetri amaçlı. */
  totalDiscovered: number;
  /** Basit bir içerik/element imzası - LoopGuard'ın "sayfa değişti mi" tespiti için. */
  stateHash: string;
  /**
   * Sayfada görünür, TIKLANABİLİR OLMAYAN hata/uyarı/bildirim metinleri (ör. "Beklenmeyen bir
   * hata oluştu", bir form doğrulama mesajı, bir toast bildirimi). `elements` listesi SADECE
   * etkileşilebilir (tıklanabilir/doldurulabilir) elementleri içerir — bu tür geri bildirim
   * metinleri interaktif olmadığı için oraya hiç girmez ve LLM'e görünmezdi. Bu, gerçek bir
   * hepsiburada.com koşumunda gözlemlendi: giriş formu bir hata gösterdi ama ajan bunu HİÇ
   * göremediği için aynı butona körü körüne tekrar tekrar tıkladı (döngü korumasına takılana
   * kadar). Bu alan o boşluğu kapatır.
   */
  alerts: string[];
}

export interface StepLogEntry {
  stepIndex: number;
  timestamp: string;
  url: string;
  decision: AgentDecision;
  /** Gerçekte uygulanan değer (secret'lar maskelenmiş olarak, örn. "***"). */
  maskedValue?: string;
  actionResult: ActionResult;
  durationMs: number;
}

/** Bir replay adımının hedef elementinin kimlik özeti — "Replay (No AI)" güvenlik doğrulaması için. */
export interface ReplayTargetSnapshot {
  tag: string;
  role: string | null;
  accessibleName: string | null;
}

/**
 * "Replay (No AI)" için gereken, BAŞARIYLA tamamlanmış bir run'ın adımlarından çıkarılan, LLM'e
 * HİÇ danışılmadan yeniden oynatılabilecek minimal karar dizisi (bkz. AgentLoop.run()'daki
 * `replaySteps` girdisi ve `collectedReplaySteps` toplama mantığı).
 *
 * GÜVENLİK NOTU: `value` KASITLI OLARAK maskelenmemiştir (ham LLM çıktısıdır) — ama bu güvenlidir:
 * LLM secret DEĞERLERİNİ hiçbir zaman görmediği için `value` yapısal olarak asla gerçek bir secret
 * değeri İÇEREMEZ, en fazla "{{secret.AD}}" gibi bir placeholder içerebilir (bkz. SecretsVault
 * dosya başı açıklaması) — tıpkı normal bir AI run'ında LLM'in ürettiği değer gibi.
 */
export interface ReplayStep {
  action: ActionType;
  targetRef?: string;
  value?: string;
  /** Replay sırasında aynı ref'in hâlâ aynı elemente karşılık geldiğini doğrulamak için kullanılır. */
  targetElementSnapshot?: ReplayTargetSnapshot;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  errorCode?: ActionErrorCode;
}

export type ActionErrorCode =
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_INTERACTABLE'
  | 'TIMEOUT'
  | 'NAVIGATION_ERROR'
  | 'ASSERTION_FAILED'
  | 'INVALID_ACTION'
  | 'UNKNOWN';

export interface RunReport {
  runId: string;
  status: RunStatus;
  url: string;
  scenario: string;
  startedAt: string;
  finishedAt?: string;
  totalSteps: number;
  llmCallCount: number;
  failureReason?: string;
  steps: StepLogEntry[];
  /** Ekran görüntüsü/video/trace istenmişse ve başarıyla yakalandıysa doldurulur. */
  artifacts?: RunArtifacts;
  /**
   * SADECE run `passed` ile bittiyse doldurulur — "Replay (No AI)" ile bu run'ın adımlarını LLM'e
   * hiç danışmadan yeniden oynatabilmek için (bkz. ReplayStep). Başarısız/hatalı run'larda LLM'in
   * "bir sonraki adım ne olmalı" diye adapte olma şansı olmadığından replay anlamsızdır — bu yüzden
   * bilinçli olarak sadece PASSED run'larda üretilir.
   */
  replaySteps?: ReplayStep[];
}

/** Çalışma zamanında runId -> canlı durum için kullanılan hafif özet. */
export interface RunSummary {
  runId: string;
  status: RunStatus;
  url: string;
  scenario: string;
  startedAt: string;
  finishedAt?: string;
  currentStep: number;
}
