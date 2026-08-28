import { Router } from 'express';
import { z } from 'zod';
import {
  addProjectMember,
  createProject,
  deleteProject,
  listProjectMembers,
  listProjects,
  removeProjectMember,
  updateProject,
} from '../../db/projectStore.js';
import { requireAdmin, type RequestWithAuthUser } from '../middleware/requireAdmin.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('adminProjectsRoute');

export const adminProjectsRouter = Router();

/**
 * v3.0 — Admin Panel / Project CRUD (Faz 1 + Faz 2). Faz 1'de kimlik doğrulama YOKTU; Faz 2 ile
 * bu router'daki TÜM route'lar requireAdmin middleware'i (bkz. aşağı) arkasına alındı — artık
 * sadece giriş yapmış bir ADMIN erişebilir.
 *
 * NEDEN tek şema hem create HEM update için: admin panel modalı (bkz. frontend
 * pages/admin-panel.html) düzenlerken bile formun TÜM alanlarını birlikte gönderir — bu route'lar
 * bu yüzden klasik "PATCH = sadece değişen alan" anlamında DEĞİL, "formun o anki tam hali"
 * anlamında çalışır (bkz. projectStore.updateProject dosya başı NOT).
 */
// v3.0 Faz 5 — GRID_URL BİLİNÇLİ OLARAK BURADA YOK: proje bazlı Grid URL hiçbir zaman run
// yürütme koduna bağlanmamıştı (bkz. BrowserManager.resolveGridUrl dosya başı NOT), kullanıcı
// bunun YERİNE Admin Panel'de tek/sabit bir global Grid URL istedi (bkz. adminSettings.ts).
const projectInputSchema = z.object({
  name: z.string().trim().min(1, 'Proje adı zorunludur').max(200, 'Proje adı en fazla 200 karakter olabilir'),
  maxParallelRuns: z.coerce.number().int('Tam sayı olmalı').positive('1 veya daha büyük olmalı').optional(),
  llmModel: z
    .string()
    .trim()
    .max(200, 'En fazla 200 karakter olabilir')
    .optional()
    .transform((v) => (v ? v : undefined)),
});

/** Oracle katmanı yapılandırılmamışken (ORACLE_DB_HOST boş) bu router'ın TÜM uç noktalarında
 * teknik "havuz açılmadı" hatası yerine anlaşılır, tek tip bir 503 döner. BİLİNÇLİ OLARAK
 * requireAdmin'DEN ÖNCE: Oracle kapalıyken kullanıcı "giriş yapmalısın" yerine daha doğru olan
 * "veritabanı yapılandırılmamış" mesajını görsün. */
adminProjectsRouter.use((_req, res, next) => {
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

// v3.0 Faz 2 — bu satırdan sonraki TÜM route'lar giriş yapmış bir ADMIN gerektirir.
adminProjectsRouter.use(requireAdmin);

adminProjectsRouter.get('/admin/projects', async (_req, res, next) => {
  try {
    const projects = await listProjects();
    res.status(200).json({ projects });
  } catch (err) {
    log.error({ err }, 'Proje listesi alınamadı');
    next(err);
  }
});

adminProjectsRouter.post('/admin/projects', async (req, res, next) => {
  const parsed = projectInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: formatZodError(parsed.error) } });
    return;
  }

  try {
    // requireAdmin bu noktaya kadar geldiyse authUser HER ZAMAN doludur — bkz. middleware.
    const createdBy = (req as RequestWithAuthUser).authUser?.userId;
    const project = await createProject({ ...parsed.data, createdBy });
    res.status(201).json({ project });
  } catch (err) {
    next(err);
  }
});

adminProjectsRouter.patch('/admin/projects/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Geçersiz proje id' } });
    return;
  }

  const parsed = projectInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: formatZodError(parsed.error) } });
    return;
  }

  try {
    const project = await updateProject(id, parsed.data);
    res.status(200).json({ project });
  } catch (err) {
    next(err);
  }
});

adminProjectsRouter.delete('/admin/projects/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Geçersiz proje id' } });
    return;
  }

  try {
    await deleteProject(id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * v3.1 — Admin Panel / Proje Üye Ataması (bkz. sohbet notu: "admin panelden proje ataması
 * yapacağız nasıl yapalım" → kullanıcı ile netleştirme: UI Projects sekmesinde satır başına
 * "Members" butonu, listede ADMIN'ler de dahil olacak şekilde). Bu üç route dosya başındaki AYNI
 * Oracle-yapılandırılmamış 503 + requireAdmin middleware zincirinin arkasında.
 */
const addProjectMemberSchema = z.object({
  userId: z.coerce.number().int('Geçersiz kullanıcı id'),
});

adminProjectsRouter.get('/admin/projects/:id/members', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Geçersiz proje id' } });
    return;
  }

  try {
    const members = await listProjectMembers(id);
    res.status(200).json({ members });
  } catch (err) {
    next(err);
  }
});

adminProjectsRouter.post('/admin/projects/:id/members', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Geçersiz proje id' } });
    return;
  }

  const parsed = addProjectMemberSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: formatZodError(parsed.error) } });
    return;
  }

  try {
    await addProjectMember(id, parsed.data.userId);
    // Ekledikten sonra güncel üye listesini döndürüyoruz — frontend ayrıca bir GET atmasın diye
    // (bkz. app.js openProjectMembersModal, tek response'la tabloyu tazeler).
    const members = await listProjectMembers(id);
    res.status(200).json({ members });
  } catch (err) {
    next(err);
  }
});

adminProjectsRouter.delete('/admin/projects/:id/members/:userId', async (req, res, next) => {
  const id = Number(req.params.id);
  const userId = Number(req.params.userId);
  if (!Number.isInteger(id) || !Number.isInteger(userId)) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Geçersiz proje veya kullanıcı id' } });
    return;
  }

  try {
    await removeProjectMember(id, userId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

function formatZodError(error: z.ZodError): string {
  return `Geçersiz istek: ${error.issues.map((i) => i.message).join('; ')}`;
}
