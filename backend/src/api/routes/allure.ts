import { Router } from 'express';
import { allureReportService } from '../allureReportServiceInstance.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('allureRoute');

export const allureRouter = Router();

/** Frontend'in "Open Last Report" butonunu etkin/pasif göstermesi için — henüz hiç rapor
 *  üretilmemişse butona basmak boş bir 404 sayfası açardı.
 *  v3.49 — `hasResults` eklendi: "Clear All Results" butonunu (bkz. sohbet notu) hem henüz hiç
 *  rapor ÜRETİLMEMİŞ ama sonuç BİRİKMİŞ hem de ikisi de boşken doğru enable/disable edebilmek
 *  için — sadece `hasReport` yeterli değildi. */
allureRouter.get('/allure/status', async (_req, res) => {
  const [hasReport, hasResults] = await Promise.all([
    allureReportService.hasReport(),
    allureReportService.hasAnyResults(),
  ]);
  res.status(200).json({ hasReport, hasResults });
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

// v3.49 — bkz. sohbet notu: "Reports kısmına eski rapor sonuçlarının tümünü silmek için bir
// buton ekle". clearResults() TASARIM GEREĞİ generateReport() ile AYNI desende hiçbir zaman
// fırlatmaz (her zaman { ok, message } döner) — yine de savunma amaçlı try/catch bırakıldı.
allureRouter.delete('/allure/results', async (_req, res) => {
  try {
    const result = await allureReportService.clearResults();
    res.status(200).json(result);
  } catch (err) {
    log.error({ err }, 'Allure sonuçlarını temizleme isteği beklenmeyen şekilde başarısız oldu');
    res.status(200).json({ ok: false, message: err instanceof Error ? err.message : 'Sonuçlar temizlenemedi.' });
  }
});
