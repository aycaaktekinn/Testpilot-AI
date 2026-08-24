import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  LLM_PROVIDER: z.enum(['openrouter', 'gemini', 'ollama']).default('openrouter'),

  // OpenRouter yalnızca LLM_PROVIDER="openrouter" iken zorunludur (aşağıdaki .superRefine'a bakın).
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('meta-llama/llama-3.3-70b-instruct:free'),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_SITE_URL: z.string().optional(),
  OPENROUTER_APP_NAME: z.string().optional(),

  // Gemini yalnızca LLM_PROVIDER="gemini" iken zorunludur. Anahtar https://aistudio.google.com/
  // üzerinden alınır.
  GEMINI_API_KEY: z.string().optional(),
  // ÖNEMLİ: GEMINI_MODEL için BİLİNÇLİ OLARAK kodda hardcoded bir varsayılan TUTULMUYOR. Google,
  // ücretsiz/kullanılabilir model adlarını zaman zaman değiştiriyor (bir model aniden "yeni
  // kullanıcılara artık açık değil" hâline gelebiliyor — bu tam olarak yaşanan sorundu). Kodda
  // sabit bir model adı tutmak bu sınıf hatayı tekrar üretir; bunun yerine LLM_PROVIDER="gemini"
  // iken bu değerin .env'de AÇIKÇA tanımlanması zorunlu kılınmıştır (bkz. aşağıdaki .superRefine).
  // Güncel, hesabınızla kullanılabilir model adını https://aistudio.google.com/ üzerinden doğrulayın;
  // yanlış/kullanılamayan bir model girerseniz GeminiProvider.validateConfig() bunu, herhangi bir
  // test adımı başlamadan ÖNCE, açık bir yapılandırma hatasıyla bildirir (bkz. AgentLoop).
  GEMINI_MODEL: z.string().optional(),
  GEMINI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta'),

  AGENT_MAX_STEPS: z.coerce.number().default(40),
  AGENT_MAX_REPEATED_ACTIONS: z.coerce.number().default(3),
  AGENT_MIN_CONFIDENCE: z.coerce.number().default(0.55),
  AGENT_STEP_TIMEOUT_MS: z.coerce.number().default(15000),
  AGENT_MAX_ELEMENTS_PER_STEP: z.coerce.number().default(80),
  // Ücretsiz LLM katmanları (hangi sağlayıcı seçiliyse) zaman zaman çok yavaş yanıt verebilir.
  // fetch() isteğinin bu süreden uzun sürmesi durumunda istek iptal edilir (AbortController) ve
  // adım hata olarak işaretlenip yeniden denenir — böylece tüm run süresiz "takılı" kalmaz.
  AGENT_LLM_TIMEOUT_MS: z.coerce.number().default(45000),

  PLAYWRIGHT_HEADLESS: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),
  PLAYWRIGHT_NAV_TIMEOUT_MS: z.coerce.number().default(30000),
  PLAYWRIGHT_DEFAULT_TIMEOUT_MS: z.coerce.number().default(10000),

  RUNS_DIR: z.string().default('./runs'),
  ARTIFACTS_DIR: z.string().default('./artifacts'),
  GENERATED_TESTS_DIR: z.string().default('./generated-tests'),

  // Allure entegrasyonu: her koşum sonunda buraya bir "*-result.json" yazılır (bkz.
  // AllureReportService), "Generate Report" butonu bunlardan ALLURE_REPORT_DIR'a statik bir
  // HTML raporu üretir (allure CLI ile), backend bu klasörü /allure-report altında sunar.
  ALLURE_RESULTS_DIR: z.string().default('./allure-results'),
  ALLURE_REPORT_DIR: z.string().default('./allure-report'),

  // Eski (legacy) frontend uyum katmanı için varsayılan tarayıcı motoru.
  LEGACY_DEFAULT_BROWSER: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),

  // v2.0 — Selenium Grid 4 hub adresi (ör. "http://localhost:4444"). Tanımlıysa, bir run
  // "useSeleniumGrid" ile başlatıldığında BrowserManager yerel bir tarayıcı başlatmak yerine bu
  // hub'da bir WebDriver session açar ve dönen CDP adresine Playwright ile bağlanır (bkz.
  // SeleniumGridClient dosya başı açıklaması). SADECE Chromium için desteklenir — Firefox/WebKit
  // Grid node'ları saf WebDriver protokolü konuşur, Playwright'ın bu motorlara ait sürücüleri CDP
  // KONUŞMAZ, bu yüzden Playwright'tan bağlanılamaz. Tanımlı değilse Grid seçeneği tamamen
  // devre dışı kalır (bkz. /api/settings — frontend bunu "configured" olarak okur).
  SELENIUM_GRID_URL: z.string().url().optional(),

  // v2.1 — SADECE backend'in KENDİSİ Docker DIŞINDA (bu makinenin üzerinde native) çalıştığı VE
  // Grid'in node'ları Docker container'ları OLDUĞU özel durumda gereklidir (bkz. SeleniumGridClient
  // dosya başı NOT). Grid hub'ının döndürdüğü CDP adresi (se:cdp) normalde node'un KENDİ Docker-içi
  // bridge network IP'sini içerir — backend bu IP'ye asla ulaşamaz. SE_NODE_HOST'u doğrudan
  // "localhost" yapmak GÖRÜNÜŞTE basit bir çözüm gibi dursa da hub'ın KENDİSİNİN node'a ulaşmasını
  // (kayıt/health-check) BOZAR (canlıda doğrulandı — kayıt sonsuz döngüye giriyordu). Bu yüzden
  // node'lara sabit birer iç IP verilir (docker-compose.override.yml) ve bu değişken o sabit IP'yi
  // gerçekten host'tan erişilebilir bir "host:port"a çeviren bir JSON harita alır, ör:
  //   {"172.28.0.11":"localhost:5561","172.28.0.12":"localhost:5562"}
  // Tanımsızsa (varsayılan) hub'dan dönen adres HİÇ değiştirilmeden kullanılır — yani Grid node'ları
  // zaten host'tan erişilebilir bir ağdaysa (ör. Docker DEĞİL, gerçek makineler) bu ayarın hiçbir
  // etkisi yoktur.
  SELENIUM_GRID_NODE_HOST_MAP: z.string().optional(),

  // v2.2 — SELENIUM_GRID_NODE_HOST_MAP ile AYNI formatta (node'un Docker-içi IP'si → host'tan
  // erişilebilir "host:port"), ama CDP portu YERİNE node'un noVNC portunu (bkz. Selenium node
  // stereotype'ındaki "se:noVncPort", genelde 7900) eşler — kullanıcının bir Grid testini
  // tarayıcısından CANLI izleyebilmesi için (bkz. SeleniumGridClient.createSession
  // dosya başı NOT). Tanımsızsa (varsayılan) canlı izleme linki hiç üretilmez — run normal şekilde
  // çalışmaya devam eder, sadece bu özellik pasif kalır.
  SELENIUM_GRID_NODE_VNC_MAP: z.string().optional(),

  // v2.0 — Vector DB (Milvus) tabanlı "locator cache": AI modunda başarıyla yürütülmüş, hedef
  // elementi olan kararlar (bkz. VectorCacheStore) arka planda embed edilip Milvus'a yazılır;
  // ileride BENZER bir durumla karşılaşıldığında bu karar bulunup LLM'e hiç danışmadan kullanılabilir
  // (bkz. AgentLoop dosya başı NOT — bu, "Replay (No AI)"tan FARKLIDIR: replay AYNI testin AYNI
  // adım sırasını birebir tekrar eder, vector cache ise FARKLI senaryolar/sayfalar arasında
  // SEMANTİK benzerlik arar). Varsayılan OLARAK KAPALIDIR (false) — hiçbir Milvus/Ollama kurulumu
  // olmadan projenin geri kalanı hiçbir şekilde etkilenmez; yazma tarafı BEST-EFFORT'tur (bkz.
  // AgentLoop.recordDecisionInCache), bir Milvus/Ollama hatası ASLA bir run'ın PASS/FAIL sonucunu
  // etkilemez, sadece loglanır.
  VECTOR_CACHE_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  // Ollama'nın yerelde dinlediği adres (bkz. docker-compose.milvus.yml dosya başı NOT — Ollama bu
  // compose'un DIŞINDA, kullanıcının kendi makinesinde `ollama serve` ile ayrıca çalışır). Bu adres
  // İKİ AYRI amaçla paylaşılır: vector cache'in embedding tarafı (OLLAMA_EMBEDDING_MODEL) VE
  // LLM_PROVIDER="ollama" iken asıl karar verici AI (OLLAMA_MODEL, bkz. aşağı) — ikisi de AYNI
  // sunucuya, ama FARKLI modellerle konuşur.
  OLLAMA_URL: z.string().url().default('http://localhost:11434'),

  // v2.3 — LLM_PROVIDER="ollama" iken zorunludur (bkz. aşağıdaki .superRefine). GEMINI_MODEL'deki
  // AYNI prensip: kodda sabit bir model adı TUTULMUYOR — hangi "chat/instruct" modelini
  // (`ollama pull <model-adı>`) indirdiğiniz tamamen size bağlıdır (ör. "llama3.1",
  // "qwen2.5:7b-instruct"). OLLAMA_EMBEDDING_MODEL'DEN FARKLIDIR: o embedding (vektör) üretimi
  // içindir, bu ise gerçek metin/karar üretimi içindir — aynı modeli ikisi için de kullanamazsınız.
  OLLAMA_MODEL: z.string().optional(),

  // ÖNEMLİ: GEMINI_MODEL'deki AYNI prensip burada da geçerli — kodda sabit bir model adı TUTULMUYOR.
  // Ollama'nın embedding model kütüphanesi zaman içinde değişebiliyor (tag adları/versiyonlar).
  // VECTOR_CACHE_ENABLED=true iken bu değerin .env'de AÇIKÇA tanımlanması zorunludur (aşağıdaki
  // .superRefine'a bakın). Kurulum: `ollama pull <model-adı>` (ör. bir Qwen embedding modeli —
  // https://ollama.com/search?c=embedding üzerinden güncel/kullanılabilir tag'i doğrulayın), sonra
  // AYNI adı buraya yazın. Yanlış/indirilmemiş bir model adı girerseniz EmbeddingClient bunu, run'ı
  // ETKİLEMEDEN (best-effort), sadece log'da net bir hatayla bildirir.
  OLLAMA_EMBEDDING_MODEL: z.string().optional(),

  // Milvus standalone'ın gRPC adresi (bkz. docker-compose.milvus.yml — varsayılan port 19530,
  // Milvus'un standart/değişmeyen portu, bu yüzden GEMINI_MODEL/OLLAMA_EMBEDDING_MODEL'in aksine
  // güvenli bir varsayılanı vardır).
  MILVUS_URL: z.string().default('http://localhost:19530'),

  // v2.0 Faz 2 — vector cache OKUMA tarafı: true ise AgentLoop, LLM'e sormadan ÖNCE Milvus'ta
  // benzer bir GEÇMİŞ karar arar (bkz. AgentLoop.tryVectorCacheHit). VECTOR_CACHE_ENABLED'dan
  // BİLİNÇLİ OLARAK AYRI bir bayraktır: kullanıcı önce sadece YAZMA tarafını (Faz 1 — veri
  // biriktirme, run davranışını hiç değiştirmez, tamamen risksiz) etkinleştirip zamanla veri
  // biriktirebilir; OKUMA tarafını (gerçek kararları etkileyen, dolayısıyla daha riskli) sadece
  // kendisi hazır hissettiğinde AYRICA açar. Varsayılan OLARAK KAPALIDIR.
  VECTOR_CACHE_READ_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),

  // Bir Milvus adayının "yeterince benzer" sayılıp LLM'siz kullanılabilmesi için gereken minimum
  // kosinüs benzerliği (0-1 arası, 1 = birebir aynı metin). BİLİNÇLİ OLARAK YÜKSEK bir varsayılan
  // (0.92) — yanlış elemente/aksiyona körü körüne güvenmektense şüpheli durumlarda LLM'e danışmaya
  // devam etmek her zaman daha güvenlidir (bkz. AgentLoop'un genel güvenlik felsefesi — "Güvenlik
  // kapısı 1" ile aynı prensip). Gerçek kullanımda gözlemlediğiniz eşleşme kalitesine göre ayarlayın.
  VECTOR_CACHE_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.92),

  // Bir arama başına Milvus'tan kaç aday çekileceği (en yüksek benzerlikten düşüğe doğru sırayla
  // denenir, eşiği geçen VE güncel sayfada gerçek bir elemente karşılık gelen ilk aday kullanılır).
  VECTOR_CACHE_TOP_K: z.coerce.number().int().min(1).default(5),

  // v2.3 — Ollama'nın embedding üretmesi bu süreden uzun sürerse iptal edilir (bkz. EmbeddingClient
  // dosya başı açıklaması). Eskiden kodda sabit 20sn idi; yerel bir embedding modelinin İLK istekte
  // Ollama'nın belleğine yüklenmesi ("cold start") — özellikle sınırlı RAM'de ve büyükçe quantize
  // modellerde (4b gibi) — bunu kolayca aşabildiği için artık .env'den ayarlanabilir, varsayılan da
  // 60sn'ye çıkarıldı. Model bir kez belleğe yüklendikten sonra sonraki istekler çok daha hızlı olur.
  VECTOR_CACHE_EMBED_TIMEOUT_MS: z.coerce.number().default(60000),

  // Statik frontend dosyalarının bulunduğu klasör. Backend, kurulumu basitleştirmek için bu
  // klasörü de kendi üzerinden (aynı origin'den) sunar — böylece frontend'in kullandığı göreli
  // "/api/..." istekleri otomatik olarak bu backend'e gider (ayrı bir sunucuya/CORS ayarına gerek kalmaz).
  FRONTEND_DIR: z.string().default('../frontend'),
}).superRefine((data, ctx) => {
  // Seçilen sağlayıcının API anahtarı zorunludur; diğer sağlayıcının anahtarı boş bırakılabilir.
  if (data.LLM_PROVIDER === 'openrouter' && !data.OPENROUTER_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OPENROUTER_API_KEY'],
      message: 'LLM_PROVIDER="openrouter" iken OPENROUTER_API_KEY gerekli',
    });
  }
  if (data.LLM_PROVIDER === 'gemini' && !data.GEMINI_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['GEMINI_API_KEY'],
      message: 'LLM_PROVIDER="gemini" iken GEMINI_API_KEY gerekli',
    });
  }
  if (data.LLM_PROVIDER === 'gemini' && !data.GEMINI_MODEL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['GEMINI_MODEL'],
      message:
        'LLM_PROVIDER="gemini" iken GEMINI_MODEL gerekli (varsayılanı yok — güncel model adını ' +
        'https://aistudio.google.com/ üzerinden doğrulayıp .env dosyanıza yazın)',
    });
  }
  if (data.LLM_PROVIDER === 'ollama' && !data.OLLAMA_MODEL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OLLAMA_MODEL'],
      message:
        'LLM_PROVIDER="ollama" iken OLLAMA_MODEL gerekli (varsayılanı yok — önce `ollama pull ' +
        '<model-adı>` ile indirdiğiniz modelin adını .env dosyanıza yazın)',
    });
  }
  if (data.VECTOR_CACHE_ENABLED && !data.OLLAMA_EMBEDDING_MODEL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OLLAMA_EMBEDDING_MODEL'],
      message:
        'VECTOR_CACHE_ENABLED=true iken OLLAMA_EMBEDDING_MODEL gerekli (varsayılanı yok — ' +
        '`ollama pull <model-adı>` ile indirdiğiniz modelin adını .env dosyanıza yazın)',
    });
  }
  if (data.VECTOR_CACHE_READ_ENABLED && !data.VECTOR_CACHE_ENABLED) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['VECTOR_CACHE_READ_ENABLED'],
      message: 'VECTOR_CACHE_READ_ENABLED=true iken VECTOR_CACHE_ENABLED=true da olmalı (okuma, yazma altyapısına bağımlıdır)',
    });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Ortam değişkenleri okunamıyorsa uygulama hemen ve anlaşılır şekilde durmalı.
  // eslint-disable-next-line no-console
  console.error('[config] Geçersiz ortam değişkenleri:', parsed.error.flatten().fieldErrors);
  throw new Error('Ortam değişkenleri doğrulanamadı. .env dosyanızı .env.example ile karşılaştırın.');
}

export const env = parsed.data;

export const defaultRunOptions = {
  maxSteps: env.AGENT_MAX_STEPS,
  headless: env.PLAYWRIGHT_HEADLESS,
  stepTimeoutMs: env.AGENT_STEP_TIMEOUT_MS,
  navigationTimeoutMs: env.PLAYWRIGHT_NAV_TIMEOUT_MS,
  defaultActionTimeoutMs: env.PLAYWRIGHT_DEFAULT_TIMEOUT_MS,
  maxElementsPerStep: env.AGENT_MAX_ELEMENTS_PER_STEP,
  maxRepeatedActions: env.AGENT_MAX_REPEATED_ACTIONS,
  minConfidence: env.AGENT_MIN_CONFIDENCE,
  viewport: { width: 1366, height: 900 },
  browserEngine: env.LEGACY_DEFAULT_BROWSER,
  captureScreenshot: false,
  captureVideo: false,
  captureTrace: false,
  useSeleniumGrid: false,
};
