import { Router } from 'express';
import { listProjects } from '../../db/projectStore.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('projectsRoute');

export const projectsRouter = Router();

/**
 * v3.0 Faz 6 — Create Test sayfasındaki proje seçici (bkz. sohbet notu: "onlar da db ye
 * kaydolması lazım" → SCENARIOS.PROJECT_ID NOT NULL olduğu için hangi projeye ait olduğu
 * bilinmeden bir senaryo Oracle'a yazılamıyor, bu yüzden kullanıcının seçmesi gerekiyor).
 *
 * BİLEREK requireAdmin DEĞİL — app.ts'te zaten site geneli requireAuth arkasında (bkz. app.ts
 * dosya başı NOT), herhangi bir giriş yapmış kullanıcı (ADMIN veya MEMBER) proje listesini
 * görebilmeli; admin router'larındaki gibi ayrıca requireAdmin eklemiyoruz. Admin router'larının
 * aksine burada AYRICA "Oracle yapılandırılmamış" 503'ü de EKLEMİYORUZ — çünkü zaten site geneli
 * requireAuth, Oracle olmadan login'in kendisini engelliyor (bkz. app.ts NOT'u); bu satıra hiç
 * ulaşılamaz durumda Oracle kapalıysa.
 */
projectsRouter.get('/projects', async (_req, res, next) => {
  try {
    const projects = await listProjects();
    res.status(200).json({ projects: projects.map((p) => ({ id: p.id, name: p.name })) });
  } catch (err) {
    log.error({ err }, 'Proje listesi alınamadı');
    next(err);
  }
});
