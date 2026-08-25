import { Router } from 'express';
import { z } from 'zod';
import {
  countAdmins,
  createLocalUser,
  deleteUser,
  getUserById,
  listUsers,
  updateUserRole,
  type UserRecord,
} from '../../db/userStore.js';
import { hashPassword } from '../../auth/password.js';
import { requireAdmin, type RequestWithAuthUser } from '../middleware/requireAdmin.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('adminUsersRoute');

export const adminUsersRouter = Router();

/**
 * v3.0 Faz 2.2 — Admin Panel "Users" sekmesi: listele + rol değiştir (ADMIN <-> MEMBER).
 *
 * v3.0 Faz 5.1 — kullanıcı OLUŞTURMA (POST /admin/users) BURAYA EKLENDİ (bkz. sohbet notu: "normal
 * user nereden ekleyeceğiz" sorusu üzerine). ESKİDEN burası bilinçli olarak yoktu — LOCAL
 * kullanıcılar sadece `npm run create-admin` terminal script'i ile (HER ZAMAN ADMIN rolünde)
 * açılabiliyordu, normal (MEMBER) bir LOCAL kullanıcı açmanın hiçbir yolu yoktu. Artık
 * createLocalUser() (userStore.ts) buradan da çağrılabiliyor, rol admin tarafından seçilebiliyor
 * (varsayılan MEMBER). LDAP kullanıcıları hâlâ BURADAN eklenmiyor — onlar ilk LDAP girişinde
 * otomatik oluşturuluyor (bkz. auth.ts / userStore.createLdapUser).
 */

adminUsersRouter.use((_req, res, next) => {
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

adminUsersRouter.use(requireAdmin);

/** PASSWORD_HASH asla frontend'e dönmez — bu tek yerden geçirilerek garanti altına alınır. */
function toPublicUser(user: UserRecord) {
  return {
    id: user.id,
    username: user.username,
    userType: user.userType,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
  };
}

adminUsersRouter.get('/admin/users', async (_req, res, next) => {
  try {
    const users = await listUsers();
    res.status(200).json({ users: users.map(toPublicUser) });
  } catch (err) {
    log.error({ err }, 'Kullanıcı listesi alınamadı');
    next(err);
  }
});

// NOT — min(6) `createAdminUser.ts` terminal script'indeki AYNI kuralla bilinçli olarak tutarlı
// (bkz. o dosyadaki "Şifre en az 6 karakter olmalı" kontrolü) — iki oluşturma yolu arasında farklı
// bir asgari şifre kuralı olmasın diye.
const createUserSchema = z.object({
  username: z.string().trim().min(1, 'Kullanıcı adı zorunludur').max(100, 'Kullanıcı adı en fazla 100 karakter olabilir'),
  displayName: z
    .string()
    .trim()
    .max(200, 'Görünen ad en fazla 200 karakter olabilir')
    .optional()
    .transform((v) => (v ? v : undefined)),
  password: z.string().min(6, 'Şifre en az 6 karakter olmalı'),
  // Varsayılan MEMBER — "normal user" tam olarak bu demek; admin isterse ADMIN de seçebilir.
  role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
});

adminUsersRouter.post('/admin/users', async (req, res, next) => {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: parsed.error.issues.map((i) => i.message).join(', ') },
    });
    return;
  }

  try {
    const user = await createLocalUser({
      username: parsed.data.username,
      passwordHash: hashPassword(parsed.data.password),
      displayName: parsed.data.displayName ?? null,
      role: parsed.data.role,
    });
    res.status(201).json({ user: toPublicUser(user) });
  } catch (err) {
    next(err);
  }
});

const roleSchema = z.object({ role: z.enum(['ADMIN', 'MEMBER']) });

adminUsersRouter.patch('/admin/users/:id/role', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Geçersiz kullanıcı id' } });
    return;
  }

  const parsed = roleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Geçersiz rol (ADMIN veya MEMBER olmalı)' } });
    return;
  }

  const currentUserId = (req as RequestWithAuthUser).authUser?.userId;

  // GÜVENLİK 1 — kendi kendini düşürememe: aksi halde bir admin yanlışlıkla kendi yetkisini
  // kaldırıp admin panele erişimini kaybedebilir (ve düzeltmek için SQL'e elle girmesi gerekirdi).
  if (currentUserId === id && parsed.data.role !== 'ADMIN') {
    res.status(400).json({
      error: { code: 'CANNOT_DEMOTE_SELF', message: 'Kendi admin yetkinizi kendiniz kaldıramazsınız.' },
    });
    return;
  }

  try {
    const target = await getUserById(id);
    if (!target) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Kullanıcı bulunamadı.' } });
      return;
    }

    // GÜVENLİK 2 — SON admin'i düşürememe: sistemde hiç admin kalmazsa admin panele KİMSE
    // giremez hale gelir (kurtarmak için yine SQL'e elle girmek gerekirdi).
    if (target.role === 'ADMIN' && parsed.data.role === 'MEMBER') {
      const adminCount = await countAdmins();
      if (adminCount <= 1) {
        res.status(400).json({
          error: { code: 'CANNOT_DEMOTE_LAST_ADMIN', message: 'Sistemdeki son admin düşürülemez.' },
        });
        return;
      }
    }

    const updated = await updateUserRole(id, parsed.data.role);
    res.status(200).json({ user: toPublicUser(updated) });
  } catch (err) {
    next(err);
  }
});

/**
 * v3.0 Faz 5.3 — kullanıcı SİLME (bkz. sohbet notu: "user silme kısmı ekleyelim, eklediğim user'ın
 * şifresini unuttum" — şifre HASH'lendiği için geri getirilemez, tek yol sil + doğru şifreyle
 * tekrar oluştur). Güvenlik kontrolleri role PATCH'indeki İKİ kuralla BİLİNÇLİ OLARAK BİREBİR AYNI
 * (kendi kendini silememe / son admin'i silememe) — aksi halde admin panele erişimi olan KİMSE
 * kalmayabilir.
 */
adminUsersRouter.delete('/admin/users/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Geçersiz kullanıcı id' } });
    return;
  }

  const currentUserId = (req as RequestWithAuthUser).authUser?.userId;

  // GÜVENLİK 1 — kendi kendini silememe.
  if (currentUserId === id) {
    res.status(400).json({
      error: { code: 'CANNOT_DELETE_SELF', message: 'Kendi hesabınızı kendiniz silemezsiniz.' },
    });
    return;
  }

  try {
    const target = await getUserById(id);
    if (!target) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Kullanıcı bulunamadı.' } });
      return;
    }

    // GÜVENLİK 2 — SON admin'i silememe.
    if (target.role === 'ADMIN') {
      const adminCount = await countAdmins();
      if (adminCount <= 1) {
        res.status(400).json({
          error: { code: 'CANNOT_DELETE_LAST_ADMIN', message: 'Sistemdeki son admin silinemez.' },
        });
        return;
      }
    }

    await deleteUser(id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
