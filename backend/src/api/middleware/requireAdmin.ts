import type { RequestHandler, Request } from 'express';
import { verifyToken, type TokenPayload } from '../../auth/token.js';
import { getAuthCookie } from '../../auth/cookie.js';

/**
 * v3.0 Faz 2 — Admin panel route'larını korur. Şu an sadece "ADMIN" rolü var (bkz. USERS.ROLE
 * CHECK constraint) — "MEMBER" rolü ileride (Faz 4) proje bazlı izinlerle anlam kazanacak, bu
 * middleware BİLİNÇLİ OLARAK sadece ADMIN/değil ayrımı yapar.
 */
export const requireAdmin: RequestHandler = (req, res, next) => {
  const token = getAuthCookie(req);
  const payload = token ? verifyToken(token) : null;

  if (!payload) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Giriş yapmanız gerekiyor.' } });
    return;
  }

  if (payload.role !== 'ADMIN') {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Bu işlem için admin yetkisi gerekiyor.' } });
    return;
  }

  (req as RequestWithAuthUser).authUser = payload;
  next();
};

export interface RequestWithAuthUser extends Request {
  authUser?: TokenPayload;
}
