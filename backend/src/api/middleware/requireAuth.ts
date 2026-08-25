import type { RequestHandler } from 'express';
import { verifyToken } from '../../auth/token.js';
import { getAuthCookie } from '../../auth/cookie.js';
import type { RequestWithAuthUser } from './requireAdmin.js';

/**
 * v3.0 Faz 2.1 — Site geneli giriş zorunluluğu. requireAdmin'DEN FARKI: rol kontrolü YAPMAZ,
 * sadece "geçerli bir oturum var mı" sorar — hem ADMIN hem MEMBER buradan geçer. Proje bazlı
 * görünürlük/izin (kim hangi projeyi görebilir) BİLİNÇLİ OLARAK burada YOK — bu Faz 4'ün konusu;
 * şimdilik "giriş yapmış herkes bugünkü gibi her şeyi görür", sadece giriş ZORUNLU hale geldi.
 */
export const requireAuth: RequestHandler = (req, res, next) => {
  const token = getAuthCookie(req);
  const payload = token ? verifyToken(token) : null;

  if (!payload) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Giriş yapmanız gerekiyor.' } });
    return;
  }

  (req as RequestWithAuthUser).authUser = payload;
  next();
};
