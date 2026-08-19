import { Router } from 'express';
import { z } from 'zod';
import { legacyTestService } from '../legacyTestServiceInstance.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('legacyTestsRoute');

export const legacyTestsRouter = Router();

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
  headed: z.boolean().optional().default(false),
  browser: browserEngineSchema.optional().default('chromium'),
  screenshot: z.boolean().optional().default(false),
  video: z.boolean().optional().default(false),
  trace: z.boolean().optional().default(false),
  variables: z.record(z.string(), z.string()).optional().default({}),
  // Hassas değerler (şifre, token vb.) — variables'tan BİLEREK ayrı; bkz. LegacyGenerateAndRunInput.
  secrets: z.record(z.string(), z.string()).optional().default({}),
});

const runExistingSchema = z.object({
  fileName: z.string().min(1),
  headed: z.boolean().optional(),
  browser: browserEngineSchema.optional(),
  screenshot: z.boolean().optional(),
  video: z.boolean().optional(),
  trace: z.boolean().optional(),
});

legacyTestsRouter.post('/tests/generate-and-run', async (req, res) => {
  const parsed = generateAndRunSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: formatZodError(parsed.error) });
    return;
  }

  try {
    const result = await legacyTestService.generateAndRun(parsed.data);
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

legacyTestsRouter.get('/test-runs', async (_req, res) => {
  try {
    const result = await legacyTestService.listTestRuns();
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'test-runs listelenemedi');
    res.status(500).json({ message: 'Test geçmişi alınamadı.', runs: [] });
  }
});

// NOT: Bu route, '/test-runs/:id' route'undan ÖNCE tanımlanmasa da sorun olmaz — Express, farklı
// segment sayısına sahip path'leri (parametresiz vs. :id'li) yapısal olarak ayırt eder, sıralama
// sadece AYNI şekle sahip route'lar arasında önem taşır (bkz. '/generated-tests' ile aynı NOT).
legacyTestsRouter.delete('/test-runs', async (_req, res) => {
  try {
    const result = await legacyTestService.clearTestRuns();
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'test-runs temizlenemedi');
    res.status(500).json({ message: errorMessage(err, 'Koşum geçmişi temizlenemedi.') });
  }
});

legacyTestsRouter.delete('/test-runs/:id', async (req, res) => {
  try {
    const result = await legacyTestService.deleteTestRun(req.params.id);
    res.status(200).json(result);
  } catch (err) {
    res.status(404).json({ message: errorMessage(err, 'Koşum silinemedi.') });
  }
});

legacyTestsRouter.get('/generated-tests', async (_req, res) => {
  try {
    const result = await legacyTestService.listGeneratedTests();
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'generated-tests listelenemedi');
    res.status(500).json({ message: 'Üretilen testler alınamadı.', tests: [] });
  }
});

legacyTestsRouter.get('/generated-tests/:fileName', async (req, res) => {
  try {
    const result = await legacyTestService.getGeneratedTestCode(req.params.fileName);
    res.status(200).json(result);
  } catch (err) {
    res.status(404).json({ message: errorMessage(err, 'Test kodu alınamadı.') });
  }
});

// NOT: Bu route, '/generated-tests/:fileName' route'undan ÖNCE tanımlanmasa da sorun olmaz —
// Express, farklı segment sayısına sahip path'leri (parametresiz vs. :fileName'li) yapısal
// olarak ayırt eder, sıralama sadece AYNI şekle sahip route'lar arasında önem taşır.
legacyTestsRouter.delete('/generated-tests', async (_req, res) => {
  try {
    const result = await legacyTestService.clearGeneratedTests();
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'generated-tests temizlenemedi');
    res.status(500).json({ message: errorMessage(err, 'Testler temizlenemedi.') });
  }
});

legacyTestsRouter.delete('/generated-tests/:fileName', async (req, res) => {
  try {
    const result = await legacyTestService.deleteGeneratedTest(req.params.fileName);
    res.status(200).json(result);
  } catch (err) {
    res.status(404).json({ message: errorMessage(err, 'Test silinemedi.') });
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
    const result = await legacyTestService.runGeneratedTest(fileName, overrides);
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
    const result = await legacyTestService.replayGeneratedTest(fileName, overrides);
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'generated-tests/replay başarısız');
    res.status(200).json(failedResultShape(errorMessage(err, 'Test AI\'sız tekrar oynatılamadı.')));
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
