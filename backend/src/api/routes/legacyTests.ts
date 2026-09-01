import { Router } from 'express';
import { z } from 'zod';
import { legacyTestService } from '../legacyTestServiceInstance.js';
import type { RequestWithAuthUser } from '../middleware/requireAdmin.js';
import type { CallerContext } from '../../domain/legacyTypes.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('legacyTestsRoute');

export const legacyTestsRouter = Router();

/**
 * v3.1 — bkz. CallerContext dosya başı açıklaması (legacyTypes.ts). Bu router zaten site geneli
 * requireAuth arkasında (bkz. app.ts) — yani `req.authUser` HER ZAMAN dolu gelir; `!` ile
 * non-null assertion bu garantiye dayanır (requireAdmin.ts'in `(req as RequestWithAuthUser)
 * .authUser = payload` ataması ile AYNI varsayım).
 */
function getCaller(req: RequestWithAuthUser): CallerContext {
  const authUser = req.authUser!;
  return { userId: authUser.userId, role: authUser.role };
}

/**
 * Bu router, mevcut (korunan) frontend'in beklediği ESKİ API sözleşmesini uygular
 * (bkz. LegacyTestService dosya başı açıklaması). Ana /api/runs API'sinden BİLEREK ayrıdır.
 *
 * Sözleşme kuralı: frontend `generate-and-run` ve `generated-tests/run` yanıtlarını her zaman
 * `response.json()` ile okuyup içindeki alanları (message, status, result...) kullanıyor; bu
 * yüzden bu endpoint'ler İŞ MANTIĞI hatalarında (senaryo başarısız oldu vb.) HTTP 200 ile
 * `status:'failed'` döner. Sadece gerçek sistem/doğrulama hatalarında 4xx/5xx + `{ message }`
 * şeklinde düz bir gövde döner (frontend'in beklediği tam olarak budur — genel errorHandler'ın
 * `{ error: { message } }` şekli burada BİLEREK kullanılmaz).
 */

const browserEngineSchema = z.enum(['chromium', 'firefox', 'webkit']);

const generateAndRunSchema = z.object({
  url: z.string().url('Geçerli bir URL giriniz'),
  scenario: z.string().min(3, 'Senaryo en az 3 karakter olmalı').max(8000),
  // v2.4 — bkz. LegacyGenerateAndRunInput.testName dosya başı açıklaması. Boş string BİLİNÇLİ
  // olarak izin verilir (kullanıcı doldurmadıysa frontend boş gönderir) — bu yüzden `.min(1)` YOK.
  testName: z.string().max(120, 'İsim en fazla 120 karakter olabilir').optional().default(''),
  headed: z.boolean().optional().default(false),
  browser: browserEngineSchema.optional().default('chromium'),
  screenshot: z.boolean().optional().default(false),
  video: z.boolean().optional().default(false),
  trace: z.boolean().optional().default(false),
  // v2.0 — bkz. RunOptions.useSeleniumGrid dosya başı açıklaması (SADECE browser "chromium" iken
  // geçerli; BrowserManager başka bir motorla birlikte gelirse net bir hatayla durur).
  useSeleniumGrid: z.boolean().optional().default(false),
  variables: z.record(z.string(), z.string()).optional().default({}),
  // Hassas değerler (şifre, token vb.) — variables'tan BİLEREK ayrı; bkz. LegacyGenerateAndRunInput.
  secrets: z.record(z.string(), z.string()).optional().default({}),
  // v3.0 Faz 6 — bkz. LegacyGenerateAndRunInput.projectId dosya başı açıklaması. OPSİYONEL:
  // kullanıcı Create Test'te proje seçmeden de test üretebilir (JSON akışı bundan etkilenmez).
  projectId: z.coerce.number().int().positive().optional(),
});

const runExistingSchema = z.object({
  fileName: z.string().min(1),
  headed: z.boolean().optional(),
  browser: browserEngineSchema.optional(),
  screenshot: z.boolean().optional(),
  video: z.boolean().optional(),
  trace: z.boolean().optional(),
  useSeleniumGrid: z.boolean().optional(),
});

const runBatchSchema = z.object({
  fileNames: z.array(z.string().min(1)).min(1, 'En az bir test seçilmeli'),
});

// v2.4 — bkz. LegacyTestService.renameGeneratedTest dosya başı açıklaması. Boş string BİLİNÇLİ
// olarak izin verilir (özel ismi kaldırıp varsayılan dosya adına dönmek için) — bu yüzden `.min(1)`
// YOK, sadece makul bir üst sınır var.
const renameSchema = z.object({
  displayName: z.string().max(120, 'İsim en fazla 120 karakter olabilir'),
});

// v3.2 — bkz. GeneratedTestSchedule dosya başı açıklaması (legacyTypes.ts). `days` en az 1 öğe
// içermelidir — 0 öğeli bir zamanlama hiçbir zaman tetiklenmez, bu kullanıcı hatasını erken
// (kayıt anında, sessizce hiç çalışmayan bir cron job kurmak yerine) yakalamak içindir.
const scheduleSchema = z.object({
  enabled: z.boolean(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Saat HH:MM formatında olmalı (ör. 23:30)'),
  days: z.array(z.number().int().min(0).max(6)).min(1, 'En az bir gün seçilmeli'),
});

// v3.2 — bkz. sohbet notu: "hiç çalıştırmadan girdiğimiz senaryoyu gece çalıştırsa". Kullanıcı
// senaryoyu HİÇ elle çalıştırmadan sadece kaydedip ilk koşumunun da zamanlanan saatte
// gerçekleşmesini istiyor. `secrets` BİLİNÇLİ OLARAK bu şemada YOK (generateAndRunSchema'nın
// aksine) — SecretsVault hiçbir zaman diske yazmaz (bkz. LegacyGenerateAndRunInput.secrets dosya
// başı açıklaması), bu yüzden gece kimsenin girmediği bir çalıştırmada secret'lar KULLANILAMAZ;
// bu alanı şemadan çıkarmak, bir kullanıcının secret gerektiren bir senaryoyu yanlışlıkla böyle
// zamanlayıp sessizce başarısız bir koşumla karşılaşmasını YAPISAL olarak engeller.
const scheduleOnlySchema = z.object({
  url: z.string().url('Geçerli bir URL giriniz'),
  scenario: z.string().min(3, 'Senaryo en az 3 karakter olmalı').max(8000),
  testName: z.string().max(120, 'İsim en fazla 120 karakter olabilir').optional().default(''),
  headed: z.boolean().optional().default(false),
  browser: browserEngineSchema.optional().default('chromium'),
  screenshot: z.boolean().optional().default(false),
  video: z.boolean().optional().default(false),
  trace: z.boolean().optional().default(false),
  useSeleniumGrid: z.boolean().optional().default(false),
  variables: z.record(z.string(), z.string()).optional().default({}),
  projectId: z.coerce.number().int().positive().optional(),
  schedule: scheduleSchema,
});

legacyTestsRouter.post('/tests/generate-and-run', async (req, res) => {
  const parsed = generateAndRunSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: formatZodError(parsed.error) });
    return;
  }

  try {
    const actingUserId = (req as RequestWithAuthUser).authUser?.userId;
    const result = await legacyTestService.generateAndRun(parsed.data, actingUserId);
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'generate-and-run başarısız');
    res.status(500).json({ message: errorMessage(err, 'Test çalıştırılamadı.') });
  }
});

// Frontend, "Generate & Run" tıklandıktan HEMEN sonra (istek daha sonuçlanmadan) bunu kısa
// aralıklarla yoklayarak aktif runId'yi öğrenir ve canlı ilerleme için `/ws/runs/:runId`
// WebSocket bağlantısını açar — bkz. LegacyTestService.getActiveRunId() dosya başı açıklaması.
legacyTestsRouter.get('/tests/current-run-id', (_req, res) => {
  res.status(200).json({ runId: legacyTestService.getActiveRunId() });
});

legacyTestsRouter.post('/tests/stop', async (_req, res) => {
  try {
    const result = await legacyTestService.stop();
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'stop başarısız');
    res.status(500).json({ message: errorMessage(err, 'Test durdurulamadı.') });
  }
});

legacyTestsRouter.get('/test-runs', async (req, res) => {
  try {
    const result = await legacyTestService.listTestRuns(getCaller(req as RequestWithAuthUser));
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'test-runs listelenemedi');
    res.status(500).json({ message: 'Test geçmişi alınamadı.', runs: [] });
  }
});

// NOT: Bu route, '/test-runs/:id' route'undan ÖNCE tanımlanmasa da sorun olmaz — Express, farklı
// segment sayısına sahip path'leri (parametresiz vs. :id'li) yapısal olarak ayırt eder, sıralama
// sadece AYNI şekle sahip route'lar arasında önem taşır (bkz. '/generated-tests' ile aynı NOT).
// v3.1 — ?before=YYYY-MM-DD verilirse Admin Panel'deki "Delete Old Runs" bakım özelliğini
// (clearTestRunsBefore) tetikler; verilmezse ESKİ davranış (hepsini temizle, clearTestRuns) AYNEN
// korunur — bkz. sohbet notu: "admin panelden eski koşumları şu tarihten itibaren sil".
legacyTestsRouter.delete('/test-runs', async (req, res) => {
  try {
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    const result = before
      ? await legacyTestService.clearTestRunsBefore(before, getCaller(req as RequestWithAuthUser))
      : await legacyTestService.clearTestRuns(getCaller(req as RequestWithAuthUser));
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'test-runs temizlenemedi');
    res.status(500).json({ message: errorMessage(err, 'Koşum geçmişi temizlenemedi.') });
  }
});

legacyTestsRouter.delete('/test-runs/:id', async (req, res) => {
  try {
    const result = await legacyTestService.deleteTestRun(req.params.id, getCaller(req as RequestWithAuthUser));
    res.status(200).json(result);
  } catch (err) {
    res.status(404).json({ message: errorMessage(err, 'Koşum silinemedi.') });
  }
});

legacyTestsRouter.get('/generated-tests', async (req, res) => {
  try {
    const result = await legacyTestService.listGeneratedTests(getCaller(req as RequestWithAuthUser));
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'generated-tests listelenemedi');
    res.status(500).json({ message: 'Üretilen testler alınamadı.', tests: [] });
  }
});

legacyTestsRouter.get('/generated-tests/:fileName', async (req, res) => {
  try {
    const result = await legacyTestService.getGeneratedTestCode(
      req.params.fileName,
      getCaller(req as RequestWithAuthUser),
    );
    res.status(200).json(result);
  } catch (err) {
    res.status(404).json({ message: errorMessage(err, 'Test kodu alınamadı.') });
  }
});

// NOT: Bu route, '/generated-tests/:fileName' route'undan ÖNCE tanımlanmasa da sorun olmaz —
// Express, farklı segment sayısına sahip path'leri (parametresiz vs. :fileName'li) yapısal
// olarak ayırt eder, sıralama sadece AYNI şekle sahip route'lar arasında önem taşır.
legacyTestsRouter.delete('/generated-tests', async (req, res) => {
  try {
    const result = await legacyTestService.clearGeneratedTests(getCaller(req as RequestWithAuthUser));
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'generated-tests temizlenemedi');
    res.status(500).json({ message: errorMessage(err, 'Testler temizlenemedi.') });
  }
});

legacyTestsRouter.delete('/generated-tests/:fileName', async (req, res) => {
  try {
    const result = await legacyTestService.deleteGeneratedTest(
      req.params.fileName,
      getCaller(req as RequestWithAuthUser),
    );
    res.status(200).json(result);
  } catch (err) {
    res.status(404).json({ message: errorMessage(err, 'Test silinemedi.') });
  }
});

// v2.4 — "senaryo ismi" (bkz. LegacyGeneratedTestMeta.displayName dosya başı açıklaması) düzenleme.
// Bilinçli olarak PATCH: sadece TEK bir alanı (displayName) günceller, kaydın geri kalanına
// dokunmaz. `/generated-tests/:fileName`'in aksine burada normal HTTP durum kodları kullanılır —
// bu YENİ bir yüzeydir, eski frontend'in "her zaman 200" sözleşmesine bağlı değildir.
legacyTestsRouter.patch('/generated-tests/:fileName/name', async (req, res) => {
  const parsed = renameSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: formatZodError(parsed.error) });
    return;
  }

  try {
    const result = await legacyTestService.renameGeneratedTest(
      req.params.fileName,
      parsed.data.displayName,
      getCaller(req as RequestWithAuthUser),
    );
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'generated-tests/:fileName/name başarısız');
    res.status(404).json({ message: errorMessage(err, 'Test yeniden adlandırılamadı.') });
  }
});

// v3.2 — bkz. GeneratedTestSchedule dosya başı açıklaması. Hem Create Test sayfası (test
// üretildikten HEMEN sonra, ayrı bir takip isteğiyle) hem Generated Tests sayfası (var olan bir
// testi sonradan zamanlamak/düzenlemek için) AYNI bu endpoint'i kullanır.
legacyTestsRouter.put('/generated-tests/:fileName/schedule', async (req, res) => {
  const parsed = scheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: formatZodError(parsed.error) });
    return;
  }

  try {
    const result = await legacyTestService.setGeneratedTestSchedule(
      req.params.fileName,
      parsed.data,
      getCaller(req as RequestWithAuthUser),
    );
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'generated-tests/:fileName/schedule (PUT) başarısız');
    res.status(404).json({ message: errorMessage(err, 'Zamanlama kaydedilemedi.') });
  }
});

legacyTestsRouter.delete('/generated-tests/:fileName/schedule', async (req, res) => {
  try {
    const result = await legacyTestService.setGeneratedTestSchedule(
      req.params.fileName,
      null,
      getCaller(req as RequestWithAuthUser),
    );
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'generated-tests/:fileName/schedule (DELETE) başarısız');
    res.status(404).json({ message: errorMessage(err, 'Zamanlama kaldırılamadı.') });
  }
});

// v3.2 — bkz. scheduleOnlySchema dosya başı açıklaması. Senaryoyu HİÇ çalıştırmadan, sadece bir
// "generated test" kaydı olarak (koddan/replaySteps'ten yoksun bir placeholder olarak) diske
// yazar ve zamanlamasını kurar — ilk gerçek koşum, zamanlanan saatte TestScheduler tarafından
// tetiklenir. Diğer eski uçların AKSİNE bu YENİ bir yüzeydir, normal HTTP durum kodları kullanılır.
legacyTestsRouter.post('/generated-tests/schedule-only', async (req, res) => {
  const parsed = scheduleOnlySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: formatZodError(parsed.error) });
    return;
  }

  try {
    const actingUserId = (req as RequestWithAuthUser).authUser?.userId;
    const result = await legacyTestService.saveScheduledScenario(parsed.data, actingUserId);
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'generated-tests/schedule-only başarısız');
    res.status(500).json({ message: errorMessage(err, 'Senaryo zamanlanamadı.') });
  }
});

legacyTestsRouter.post('/generated-tests/run', async (req, res) => {
  const parsed = runExistingSchema.safeParse(req.body);
  if (!parsed.success) {
    // NOT: Bu endpoint'i frontend `response.ok` KONTROL ETMEDEN kullanıyor — HTTP durum kodundan
    // bağımsız olarak gövdeyi her zaman "başarılı sonuç" gibi okuyor. Bu yüzden burada da,
    // 400/404 gibi durumlarda bile, frontend'in beklediği tam `LegacyTestResultResponse` şeklinde
    // bir "failed" sonucu döndürüyoruz — düz bir { message } gövdesi UI'da undefined alanlara yol açar.
    res.status(200).json(failedResultShape(formatZodError(parsed.error)));
    return;
  }

  try {
    const { fileName, ...overrides } = parsed.data;
    const result = await legacyTestService.runGeneratedTest(
      fileName,
      overrides,
      getCaller(req as RequestWithAuthUser),
    );
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'generated-tests/run başarısız');
    res.status(200).json(failedResultShape(errorMessage(err, 'Test çalıştırılamadı.')));
  }
});

// "Replay (No AI)" — bkz. LegacyTestService.replayGeneratedTest() dosya başı açıklaması. Aynı
// istek şeması (runExistingSchema) ve aynı yanıt sözleşmesi kuralı (HTTP 200 + status:'failed')
// /generated-tests/run ile paylaşılır — frontend'in beklediği davranış birebir aynıdır.
legacyTestsRouter.post('/generated-tests/replay', async (req, res) => {
  const parsed = runExistingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(200).json(failedResultShape(formatZodError(parsed.error)));
    return;
  }

  try {
    const { fileName, ...overrides } = parsed.data;
    const result = await legacyTestService.replayGeneratedTest(
      fileName,
      overrides,
      getCaller(req as RequestWithAuthUser),
    );
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'generated-tests/replay başarısız');
    res.status(200).json(failedResultShape(errorMessage(err, 'Test AI\'sız tekrar oynatılamadı.')));
  }
});

/**
 * v2.0 — checkbox ile seçilen birden fazla generated test'i GERÇEKTEN paralel olarak başlatır
 * (bkz. LegacyTestService.runGeneratedTestsBatch dosya başı açıklaması). Yukarıdaki tekli
 * endpoint'lerin AKSİNE, eski frontend'in beklediği bir sözleşmeye bağlı değildir (bu yeni bir
 * yüzeydir) — bu yüzden normal HTTP durum kodları kullanılır (her zaman 200 + failedResultShape
 * numarası YOK) ve yanıt bloklamadan hemen döner: her öğe için ya bir `runId` (canlı takip için
 * `/ws/runs/:runId`'ye bağlanılır) ya da bir `error` içerir, PASS/FAIL sonucu bu yanıtta YOKTUR.
 */
legacyTestsRouter.post('/generated-tests/run-batch', async (req, res) => {
  const parsed = runBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: formatZodError(parsed.error) });
    return;
  }

  try {
    const results = await legacyTestService.runGeneratedTestsBatch(
      parsed.data.fileNames,
      getCaller(req as RequestWithAuthUser),
    );
    res.status(200).json({ results });
  } catch (err) {
    log.error({ err }, 'generated-tests/run-batch başarısız');
    res.status(500).json({ message: errorMessage(err, 'Toplu çalıştırma başlatılamadı.') });
  }
});

function failedResultShape(message: string) {
  return {
    generatedCode: '',
    testFile: '',
    status: 'failed' as const,
    message,
    result: { output: '', errorOutput: message, exitCode: 1, artifacts: {} },
  };
}

function formatZodError(error: z.ZodError): string {
  return `Geçersiz istek: ${error.issues.map((i) => i.message).join('; ')}`;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}
