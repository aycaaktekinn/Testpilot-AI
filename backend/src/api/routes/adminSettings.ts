import { Router } from 'express';
import { z } from 'zod';
import { getGlobalSettings, upsertGlobalSettings } from '../../db/globalSettingsStore.js';
import { requireAdmin, type RequestWithAuthUser } from '../middleware/requireAdmin.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('adminSettingsRoute');

export const adminSettingsRouter = Router();

/**
 * v3.0 Faz 5 — Admin Panel'deki (Projects/Users/LDAP sekmelerinin ÜSTÜNDE, ayrı bir alan olarak,
 * bkz. sohbet notu) sabit/global Grid URL ayarı. Proje bazlı Grid URL alanı BİLİNÇLİ OLARAK
 * KALDIRILDI (bkz. adminProjects.ts/projectStore.ts dosya başı NOT'ları — hiçbir zaman run
 * yürütme koduna bağlanmamıştı) — bunun YERİNE geçen TEK global ayar burada.
 */

adminSettingsRouter.use((_req, res, next) => {
  if (!env.ORACLE_DB_HOST) {
    res.status(503).json({
      error: {
        code: 'ORACLE_NOT_CONFIGURED',
        message: 'Oracle veritabanı yapılandırılmamış (.env dosyasında ORACLE_DB_HOST eksik).',
      },
    });
    return;
  }
  next();
});

adminSettingsRouter.use(requireAdmin);

adminSettingsRouter.get('/admin/global-settings', async (_req, res, next) => {
  try {
    const settings = await getGlobalSettings();
    res.status(200).json({
      settings: settings ? { gridUrl: settings.gridUrl, updatedAt: settings.updatedAt } : null,
    });
  } catch (err) {
    log.error({ err }, 'Global ayarlar okunamadı');
    next(err);
  }
});

// NOT — eski regex (/^https?:\/\/.+/i) "http://5555" gibi değerleri de GEÇERLİ sayıyordu, çünkü
// ".+" sadece "http://" sonrasında EN AZ 1 karakter istiyordu (host var mı diye bakmıyordu).
// Gerçek bir kullanıcı bunu yaşadı: "http://localhost:5555" yazmak isterken host kısmını
// unutup sadece "http://5555" yazdı — bu, eski regex'ten geçip öylece kaydedildi (kutuda "hep
// aynı" görünmesinin sebebi aslında budur: kaydedilen değer TAM OLARAK budur). Şimdi gerçek bir
// URL parser (new URL()) kullanıyoruz VE host'un SADECE rakamlardan oluştuğu (ör. "5555") özel
// durumunu ayrıca reddediyoruz — çünkü bu neredeyse her zaman "host'u yazmayı unutup port'u host
// yerine yazma" hatasıdır, gerçek bir hostname değildir.
function isValidGridUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  if (!parsed.hostname) {
    return false;
  }
  if (/^\d+$/.test(parsed.hostname)) {
    // "http://5555" → hostname "5555", port yok — bkz. yukarıdaki NOT.
    return false;
  }
  return true;
}

const globalSettingsInputSchema = z.object({
  gridUrl: z
    .string()
    .optional()
    .transform((v) => (v ?? '').trim())
    .transform((v) => (v.length === 0 ? null : v))
    .refine((v) => v === null || isValidGridUrl(v), {
      message:
        'Grid URL geçerli bir host içermeli, ör. http://localhost:4444 (sadece port yazıp host\'u ' +
        'unutmuş olabilirsin — "http://5555" gibi bir değer artık kabul edilmiyor).',
    }),
});

adminSettingsRouter.put('/admin/global-settings', async (req, res, next) => {
  const parsed = globalSettingsInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: parsed.error.issues.map((i) => i.message).join(', '),
      },
    });
    return;
  }

  const updatedBy = (req as RequestWithAuthUser).authUser?.userId ?? null;

  try {
    const updated = await upsertGlobalSettings({ gridUrl: parsed.data.gridUrl, updatedBy });
    res.status(200).json({ settings: { gridUrl: updated.gridUrl, updatedAt: updated.updatedAt } });
  } catch (err) {
    log.error({ err }, 'Global ayarlar kaydedilemedi');
    next(err);
  }
});
