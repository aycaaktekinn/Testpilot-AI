import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  LLM_PROVIDER: z.enum(['openrouter', 'gemini']).default('openrouter'),

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
};
