import { Router } from 'express';
import { z } from 'zod';
import { getLdapConfig, upsertLdapConfig } from '../../db/ldapConfigStore.js';
import { requireAdmin, type RequestWithAuthUser } from '../middleware/requireAdmin.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../config/logger.js';
import { authenticateAgainstLdap } from '../../auth/ldapClient.js';
import { encryptSecret } from '../../auth/secretCrypto.js';

const log = createLogger('adminLdapRoute');

export const adminLdapRouter = Router();

/**
 * v3.0 Faz 2.3 — Admin Panel "LDAP" sekmesi: şirketin LDAP sunucu bilgilerinin okunup/kaydedildiği
 * uç noktalar. Gerçek LDAP BIND doğrulaması (ve LDAP kullanıcılarının otomatik oluşturulması) BURADA
 * DEĞİL, Faz 2.4'te (ldapClient.ts + /auth/login'e entegrasyon) yapılacak — bu route SADECE
 * yapılandırmayı okur/yazar, hiçbir LDAP sunucusuna BAĞLANMAZ.
 */

adminLdapRouter.use((_req, res, next) => {
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

adminLdapRouter.use(requireAdmin);

/**
 * GÜVENLİK: Manager Password ASLA client'a gerçek değeriyle dönülmez — sadece "kayıtlı bir şifre
 * var mı" (boolean, bkz. settings.ts maskApiKey() İLE AYNI prensip). Diğer alanlar (URL, DN'ler,
 * filtreler, encoder tipi) sır DEĞİLDİR, olduğu gibi döner — formun "kaydedilmiş değeri göster"
 * davranışı için gerekli.
 */
adminLdapRouter.get('/admin/ldap-config', async (_req, res, next) => {
  try {
    const config = await getLdapConfig();
    if (!config) {
      res.status(200).json({ config: null });
      return;
    }
    res.status(200).json({
      config: {
        url: config.url,
        baseDn: config.baseDn,
        managerDn: config.managerDn,
        managerPasswordConfigured: Boolean(config.managerPasswordEncrypted),
        userDnPattern: config.userDnPattern,
        userSearchFilter: config.userSearchFilter,
        groupSearchBase: config.groupSearchBase,
        groupSearchFilter: config.groupSearchFilter,
        passwordEncoderType: config.passwordEncoderType,
        updatedAt: config.updatedAt,
      },
    });
  } catch (err) {
    log.error({ err }, 'LDAP yapılandırması okunamadı');
    next(err);
  }
});

// Boş string'ler `.optional()` alanlarda "gönderilmedi" gibi ele alınabilsin diye `nullable()` DEĞİL
// `.optional()` kullanılıyor; frontend boş bırakılan alanlar için "" gönderir, bu da null'a çevrilir
// (bkz. aşağıdaki `.transform`) — DB'de NULL olarak saklanması, LDAP entegrasyonu Faz 2.4'te
// tamamlanmadan bu alanların "boş" (yapılandırılmamış) sayılması gerektiği için doğru davranış.
const emptyToNull = z
  .string()
  .transform((v) => (v.trim().length === 0 ? null : v))
  .nullable()
  .optional()
  .transform((v) => v ?? null);

const ldapConfigInputSchema = z.object({
  url: emptyToNull,
  baseDn: emptyToNull,
  managerDn: emptyToNull,
  // Boş string = "değiştirme, mevcut şifreyi koru" (bkz. ldapConfigStore.ts UpsertLdapConfigInput
  // dosya başı NOT). Bu yüzden BİLEREK emptyToNull KULLANILMIYOR — boş string ile hiç gönderilmemiş
  // arasında fark YOK burada, ikisi de "koru" anlamına gelir, bu yüzden aynı `.optional()` +
  // boşsa-null dönüşümü yeterli.
  managerPassword: emptyToNull,
  userDnPattern: emptyToNull,
  userSearchFilter: emptyToNull,
  groupSearchBase: emptyToNull,
  groupSearchFilter: emptyToNull,
  passwordEncoderType: z.enum(['NO', 'PLAIN', 'SHA', 'LDAP_SHA', 'MD4', 'MD5']),
});

adminLdapRouter.put('/admin/ldap-config', async (req, res, next) => {
  const parsed = ldapConfigInputSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Geçersiz LDAP yapılandırması: ' + parsed.error.issues.map((i) => i.message).join(', '),
      },
    });
    return;
  }

  const updatedBy = (req as RequestWithAuthUser).authUser?.userId ?? null;

  try {
    const updated = await upsertLdapConfig({
      url: parsed.data.url,
      baseDn: parsed.data.baseDn,
      managerDn: parsed.data.managerDn,
      managerPassword: parsed.data.managerPassword,
      userDnPattern: parsed.data.userDnPattern,
      userSearchFilter: parsed.data.userSearchFilter,
      groupSearchBase: parsed.data.groupSearchBase,
      groupSearchFilter: parsed.data.groupSearchFilter,
      passwordEncoderType: parsed.data.passwordEncoderType,
      updatedBy,
    });

    res.status(200).json({
      config: {
        url: updated.url,
        baseDn: updated.baseDn,
        managerDn: updated.managerDn,
        managerPasswordConfigured: Boolean(updated.managerPasswordEncrypted),
        userDnPattern: updated.userDnPattern,
        userSearchFilter: updated.userSearchFilter,
        groupSearchBase: updated.groupSearchBase,
        groupSearchFilter: updated.groupSearchFilter,
        passwordEncoderType: updated.passwordEncoderType,
        updatedAt: updated.updatedAt,
      },
    });
  } catch (err) {
    log.error({ err }, 'LDAP yapılandırması kaydedilemedi');
    next(err);
  }
});

/**
 * v3.0 Faz 2.4 — LDAP yapılandırmasını TEST etme.
 * Save butonuna basıldığında, yapılandırma kaydedilmeden ÖNCE (ya da kaydedildikten SONRA)
 * bu endpoint çağrılır ve gerçek LDAP sunucusuna bağlanıp test kullanıcısı ile giriş denenir.
 */
adminLdapRouter.post('/admin/ldap-test', async (req, res, next) => {
  const testUserSchema = z.object({
    testUsername: z.string().trim().min(1, 'Test kullanıcı adı gerekli'),
    testPassword: z.string().min(1, 'Test şifresi gerekli'),
  });

  const parsed = testUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Test kullanıcı bilgileri gerekli: ' + parsed.error.issues.map((i) => i.message).join(', '),
      },
    });
    return;
  }

  if (!env.ORACLE_DB_HOST) {
    res.status(503).json({
      error: {
        code: 'ORACLE_NOT_CONFIGURED',
        message: 'Oracle veritabanı yapılandırılmamış (.env dosyasında ORACLE_DB_HOST eksik).',
      },
    });
    return;
  }

  try {
    // Mevcut yapılandırmayı al
    const config = await getLdapConfig();
    if (!config) {
      res.status(400).json({
        error: {
          code: 'LDAP_NOT_CONFIGURED',
          message: 'LDAP yapılandırması bulunamadı. Önce LDAP bilgilerini kaydedin.',
        },
      });
      return;
    }

    // LDAP doğrulamasını dene
    const result = await authenticateAgainstLdap(
      parsed.data.testUsername,
      parsed.data.testPassword,
      config,
    );

    if (result.success) {
      res.status(200).json({
        success: true,
        message: `LDAP bağlantısı başarılı. Kullanıcı "${parsed.data.testUsername}" başarıyla doğrulandı.`,
        displayName: result.displayName,
      });
    } else {
      res.status(401).json({
        error: {
          code: 'LDAP_AUTH_FAILED',
          message: `LDAP doğrulama başarısız: ${result.reason}`,
        },
      });
    }
  } catch (err) {
    log.error({ err }, 'LDAP testi başarısız');
    res.status(500).json({
      error: {
        code: 'LDAP_TEST_FAILED',
        message: 'LDAP testi sırasında bir hata oluştu: ' + (err instanceof Error ? err.message : String(err)),
      },
    });
  }
});
