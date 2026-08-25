import { Router } from 'express';
import { z } from 'zod';
import { getUserByUsername, createLdapUser, type UserRecord } from '../../db/userStore.js';
import { verifyPassword } from '../../auth/password.js';
import { signToken, verifyToken } from '../../auth/token.js';
import { getAuthCookie, serializeAuthCookie, clearAuthCookieHeader } from '../../auth/cookie.js';
import { getLdapConfig } from '../../db/ldapConfigStore.js';
import { authenticateAgainstLdap } from '../../auth/ldapClient.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../config/logger.js';
import type { Response } from 'express';

const log = createLogger('authRoute');

export const authRouter = Router();

const loginSchema = z.object({
  username: z.string().trim().min(1, 'Kullanıcı adı gerekli'),
  password: z.string().min(1, 'Şifre gerekli'),
});

authRouter.post('/auth/login', async (req, res, next) => {
  if (!env.ORACLE_DB_HOST) {
    res.status(503).json({
      error: {
        code: 'ORACLE_NOT_CONFIGURED',
        message: 'Oracle veritabanı yapılandırılmamış (.env dosyasında ORACLE_DB_HOST eksik).',
      },
    });
    return;
  }

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Kullanıcı adı ve şifre gerekli.' } });
    return;
  }

  try {
    const user = await getUserByUsername(parsed.data.username);

    // 1) LOCAL kullanıcı (ör. `npm run create-admin` ile oluşturulan bootstrap admin): mevcut
    // şifre-hash doğrulama akışı AYNEN korunur. BİLİNÇLİ OLARAK burada LDAP'a HİÇ düşülmez —
    // username LOCAL olarak KAYITLIYSA (şifre yanlış olsa BİLE) o kimlik LOCAL kabul edilir, aynı
    // username'i LDAP'ta da denemek beklenmedik/güvensiz bir çapraz-doğrulama olurdu.
    if (user && user.userType === 'LOCAL') {
      if (!user.passwordHash || !verifyPassword(parsed.data.password, user.passwordHash)) {
        res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Kullanıcı adı veya şifre hatalı.' } });
        return;
      }
      issueSessionAndRespond(res, user);
      return;
    }

    // 2) LDAP (v3.0 Faz 2.4): kullanıcı ya HİÇ yok (şirketten ilk kez giriş yapan biri) ya da zaten
    // USER_TYPE='LDAP' (tekrar giriş — şifre bizim tarafımızda HİÇ saklanmadığı için HER SEFERİNDE
    // yeniden LDAP sunucusuna karşı doğrulanır, bkz. ldapClient.ts dosya başı NOT). LDAP hiç
    // yapılandırılmamışsa (getLdapConfig() undefined) bu blok TAMAMEN atlanır.
    const ldapConfig = await getLdapConfig();
    if (ldapConfig) {
      const ldapResult = await authenticateAgainstLdap(parsed.data.username, parsed.data.password, ldapConfig);

      if (ldapResult.success) {
        let authenticatedUser: UserRecord | undefined = user;

        if (!authenticatedUser) {
          // İLK GİRİŞ — otomatik provizyon. ROLE HER ZAMAN 'MEMBER' (bkz. createLdapUser dosya başı
          // NOT — kullanıcının sohbette belirttiği kural).
          try {
            authenticatedUser = await createLdapUser({
              username: parsed.data.username,
              displayName: ldapResult.displayName,
            });
          } catch (err) {
            // Yarış durumu: aynı yeni kullanıcı için eşzamanlı iki istek — diğeri muhtemelen zaten
            // oluşturdu, tekrar okuyup devam ediyoruz (bkz. createLdapUser dosya başı NOT).
            authenticatedUser = await getUserByUsername(parsed.data.username);
            if (!authenticatedUser) {
              throw err;
            }
          }
        }

        issueSessionAndRespond(res, authenticatedUser);
        return;
      }

      log.info({ username: parsed.data.username, reason: ldapResult.reason }, 'LDAP girişi başarısız');
    }

    // NEDEN buraya düşüldüğünde de AYNI genel "hatalı" mesajı: hangi alanın (kullanıcı adı mı
    // şifre mi, ya da LDAP mi LOCAL mi) yanlış olduğunu ayrıca belirtmek, saldırgana hangi kullanıcı
    // adlarının SİSTEMDE VAR olduğunu (enumeration) ifşa eder — bilinçli olarak kaçınıldı.
    res.status(401).json({ error: { code: 'INVALID_CREDENTIALS', message: 'Kullanıcı adı veya şifre hatalı.' } });
  } catch (err) {
    log.error({ err }, 'Giriş başarısız');
    next(err);
  }
});

function issueSessionAndRespond(res: Response, user: UserRecord): void {
  const token = signToken({ userId: user.id, username: user.username, role: user.role });
  res.setHeader('Set-Cookie', serializeAuthCookie(token, env.AUTH_TOKEN_TTL_HOURS * 3600));
  res.status(200).json({
    user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role },
  });
}

authRouter.post('/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearAuthCookieHeader());
  res.status(204).send();
});

/** Frontend'in sayfa yüklendiğinde "zaten giriş yapılmış mı" kontrolü için — bkz.
 * app.js initAdminPanelPage()'in başındaki checkAdminAuth(). */
authRouter.get('/auth/me', (req, res) => {
  const token = getAuthCookie(req);
  const payload = token ? verifyToken(token) : null;

  if (!payload) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Giriş yapılmamış.' } });
    return;
  }

  res.status(200).json({ user: { id: payload.userId, username: payload.username, role: payload.role } });
});
