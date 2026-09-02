import { Router } from 'express';
import { testRunRequestSchema, bddDescriptionUpdateSchema } from '../../domain/requestSchema.js';
import { validateBody } from '../middleware/validateBody.js';
import { runManager } from '../runManager.js';
import type { RequestWithAuthUser } from '../middleware/requireAdmin.js';
import { NotFoundError } from '../../domain/errors.js';

export const runsRouter = Router();

/**
 * v3.1 — bkz. LegacyTestService.isVisibleTo() dosya başı NOT'u (AYNI kural burada da geçerli):
 * ADMIN her run'ı görür/iptal eder; MEMBER SADECE kendi başlattığı (`ownerId` eşleşen) run'lara
 * erişebilir. `ownerId` `null`/`undefined` ise (bu router zaten sadece bu değişiklikten SONRA
 * başlatılan run'ları bellek-içi tutar — bkz. RunSummary.ownerId dosya başı açıklaması) MEMBER'a
 * gösterilmez.
 */
function assertRunAccess(req: RequestWithAuthUser, ownerId: number | null | undefined, runId: string): void {
  const authUser = req.authUser;
  if (authUser?.role === 'ADMIN') return;
  if (!authUser || ownerId == null || ownerId !== authUser.userId) {
    throw new NotFoundError(`Run bulunamadı: ${runId}`);
  }
}

/** Yeni bir test run'ı başlatır. Hemen döner; ilerleme GET veya WS ile takip edilir. */
runsRouter.post('/runs', validateBody(testRunRequestSchema), (req, res) => {
  const authUser = (req as RequestWithAuthUser).authUser;
  const summary = runManager.startRun(req.body, authUser?.userId);
  res.status(202).json(summary);
});

/** Run'ın güncel durumunu (status, currentStep) döner. */
runsRouter.get('/runs/:id', (req, res) => {
  const summary = runManager.getSummary(req.params.id);
  assertRunAccess(req as RequestWithAuthUser, summary.ownerId, req.params.id);
  res.json(summary);
});

/** Run tamamlandıysa, tüm adımları ve PASS/FAIL sonucunu içeren tam raporu döner. */
runsRouter.get('/runs/:id/report', (req, res) => {
  const summary = runManager.getSummary(req.params.id);
  assertRunAccess(req as RequestWithAuthUser, summary.ownerId, req.params.id);
  const report = runManager.getReport(req.params.id);
  res.json(report);
});

/** Devam eden bir run'ı iptal eder. */
runsRouter.post('/runs/:id/cancel', (req, res) => {
  const summary = runManager.getSummary(req.params.id);
  assertRunAccess(req as RequestWithAuthUser, summary.ownerId, req.params.id);
  const cancelled = runManager.cancelRun(req.params.id);
  res.json(cancelled);
});

/**
 * v3.10 — "BDD" paneli: otomatik üretilen özeti YA DA kullanıcının panelde yaptığı düzenlemeyi
 * kaydeder. Run tamamlanmış olmalıdır (bkz. RunManager.updateBddDescription dosya başı NOT'u).
 */
runsRouter.patch('/runs/:id/bdd-description', validateBody(bddDescriptionUpdateSchema), async (req, res) => {
  const summary = runManager.getSummary(req.params.id);
  assertRunAccess(req as RequestWithAuthUser, summary.ownerId, req.params.id);
  const report = await runManager.updateBddDescription(req.params.id, req.body.bddDescription);
  res.json(report);
});
