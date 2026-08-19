import { Router } from 'express';
import { testRunRequestSchema } from '../../domain/requestSchema.js';
import { validateBody } from '../middleware/validateBody.js';
import { runManager } from '../runManager.js';

export const runsRouter = Router();

/** Yeni bir test run'ı başlatır. Hemen döner; ilerleme GET veya WS ile takip edilir. */
runsRouter.post('/runs', validateBody(testRunRequestSchema), (req, res) => {
  const summary = runManager.startRun(req.body);
  res.status(202).json(summary);
});

/** Run'ın güncel durumunu (status, currentStep) döner. */
runsRouter.get('/runs/:id', (req, res) => {
  const summary = runManager.getSummary(req.params.id);
  res.json(summary);
});

/** Run tamamlandıysa, tüm adımları ve PASS/FAIL sonucunu içeren tam raporu döner. */
runsRouter.get('/runs/:id/report', (req, res) => {
  const report = runManager.getReport(req.params.id);
  res.json(report);
});

/** Devam eden bir run'ı iptal eder. */
runsRouter.post('/runs/:id/cancel', (req, res) => {
  const summary = runManager.cancelRun(req.params.id);
  res.json(summary);
});
