import { Router } from 'express';
import { listProjects, listProjectsForUser } from '../../db/projectStore.js';
import type { RequestWithAuthUser } from '../middleware/requireAdmin.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('projectsRoute');

export const projectsRouter = Router();

/**
 * v3.0 Faz 6 — Create Test sayfasındaki proje seçici (bkz. sohbet notu: "onlar da db ye
 * kaydolması lazım" → SCENARIOS.PROJECT_ID NOT NULL olduğu için hangi projeye ait olduğu
 * bilinmeden bir senaryo Oracle'a yazılamıyor, bu yüzden kullanıcının seçmesi gerekiyor).
 *
 * BİLEREK requireAdmin DEĞİL — app.ts'te zaten site geneli requireAuth arkasında (bkz. app.ts
 * dosya başı NOT), herhangi bir giriş yapmış kullanıcı (ADMIN veya MEMBER) bu endpoint'e
 * erişebilmeli; admin router'larındaki gibi ayrıca requireAdmin eklemiyoruz. Admin router'larının
 * aksine burada AYRICA "Oracle yapılandırılmamış" 503'ü de EKLEMİYORUZ — çünkü zaten site geneli
 * requireAuth, Oracle olmadan login'in kendisini engelliyor (bkz. app.ts NOT'u); bu satıra hiç
 * ulaşılamaz durumda Oracle kapalıysa.
 *
 * v3.1 — GÖRÜNÜRLÜK ARTIK ROL BAZLI: ADMIN hâlâ `listProjects()` ile TÜM projeleri görür; MEMBER
 * ise SADECE `PROJECT_MEMBERS`'ta kendisine atanmış projeleri (`listProjectsForUser`) görür — bkz.
 * Test Runs/Generated Tests'teki AYNI "admin hepsini görür, member sadece kendininkini görür"
 * kuralı (CallerContext, LegacyTestService.isVisibleTo).
 */
projectsRouter.get('/projects', async (req, res, next) => {
  try {
    const authUser = (req as RequestWithAuthUser).authUser;
    const projects =
      authUser && authUser.role !== 'ADMIN' ? await listProjectsForUser(authUser.userId) : await listProjects();
    res.status(200).json({ projects: projects.map((p) => ({ id: p.id, name: p.name })) });
  } catch (err) {
    log.error({ err }, 'Proje listesi alınamadı');
    next(err);
  }
});
