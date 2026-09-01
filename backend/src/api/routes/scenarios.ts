import { Router } from 'express';
import { z } from 'zod';
import { scenarioSuggester } from '../scenarioSuggesterInstance.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('scenariosRoute');

export const scenariosRouter = Router();

const suggestSchema = z.object({
  url: z.string().url('Geçerli bir URL giriniz'),
  // Varsayılan true: bkz. ScenarioSuggester.scanPage() dosya başı açıklaması — birçok site
  // (ör. hepsiburada.com) headless Chromium'u bot-koruması ile tespit edip boş sayfa döndürüyor.
  headed: z.boolean().optional().default(true),
  // "Get More Suggestions" akışı: frontend, kullanıcıya bu oturumda ZATEN gösterilmiş senaryo
  // metinlerini burada geri gönderir — bkz. ScenarioSuggester.suggest() üçüncü parametresi.
  existingScenarios: z.array(z.string()).optional().default([]),
  // Kullanıcının "sadece login sayfasıyla ilgili senaryo üret" gibi serbest metin bir yönlendirmesi
  // — opsiyonel, boşsa AI eskisi gibi sayfanın GENELİNE göre öneriyor. Bkz. ScenarioSuggester.suggest()
  // dördüncü parametresi ve SYSTEM_PROMPT kural 10.
  focus: z.string().trim().max(300, 'İstek en fazla 300 karakter olabilir').optional().default(''),
  // v3.3 — verilirse, tarama ÖNCESİNDE kısa bir AI destekli giriş adımı çalıştırılır (bkz.
  // ScenarioSuggester.performLogin). Bkz. ScenarioSuggester.suggest() beşinci parametresi.
  login: z
    .object({
      url: z.string().url('Geçerli bir giriş sayfası URL\'si giriniz').optional(),
      scenario: z
        .string()
        .trim()
        .min(1, 'Giriş senaryosu boş olamaz')
        .max(1000, 'Giriş senaryosu en fazla 1000 karakter olabilir'),
      variables: z.record(z.string(), z.string()).optional().default({}),
      secrets: z.record(z.string(), z.string()).optional().default({}),
    })
    .optional(),
});

/**
 * Verilen URL'yi GERÇEKTEN ziyaret edip (tek seferlik, salt-okunur bir DOM taraması — hiçbir
 * aksiyon almaz) LLM'den bu sayfaya özgü senaryo önerileri ister. Express 4 async route
 * handler'larda promise reddini OTOMATİK yakalamaz — bu yüzden try/catch + next(err) BİLİNÇLİ
 * olarak burada yapılıyor (errorHandler middleware'inin AppError'ları doğru statü koduyla
 * işleyebilmesi için).
 */
scenariosRouter.post('/scenarios/suggest', async (req, res, next) => {
  const parsed = suggestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: formatZodError(parsed.error) } });
    return;
  }

  try {
    const suggestions = await scenarioSuggester.suggest(
      parsed.data.url,
      parsed.data.headed,
      parsed.data.existingScenarios,
      parsed.data.focus,
      parsed.data.login,
    );
    res.status(200).json({ suggestions });
  } catch (err) {
    log.warn({ err, url: parsed.data.url }, 'Senaryo önerisi başarısız');
    next(err);
  }
});

function formatZodError(error: z.ZodError): string {
  return `Geçersiz istek: ${error.issues.map((i) => i.message).join('; ')}`;
}
