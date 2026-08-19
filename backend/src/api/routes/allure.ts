import { Router } from 'express';
import { allureReportService } from '../allureReportServiceInstance.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('allureRoute');

export const allureRouter = Router();

/** Frontend'in "Open Last Report" butonunu etkin/pasif göstermesi için — henüz hiç rapor
 *  üretilmemişse butona basmak boş bir 404 sayfası açardı. */
allureRouter.get('/allure/status', async (_req, res) => {
  const hasReport = await allureReportService.hasReport();
  res.status(200).json({ hasReport });
});

// NOT: generateReport() TASARIM GEREĞİ hiçbir zaman fırlatmaz (her zaman { ok, message } döner —
// bkz. AllureReportService dosya başı açıklaması), bu yüzden burada 500 dönmesi beklenmez; yine
// de savunma amaçlı try/catch bırakıldı.
allureRouter.post('/allure/generate', async (_req, res) => {
  try {
    const result = await allureReportService.generateReport();
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'Allure raporu oluşturma isteği beklenmeyen şekilde başarısız oldu');
    res.status(200).json({ ok: false, message: err instanceof Error ? err.message : 'Rapor oluşturulamadı.' });
  }
});
