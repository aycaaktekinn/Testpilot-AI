import oracledb from 'oracledb';
import { withConnection } from './oracleClient.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';

/**
 * v3.0 Faz 2 / 2.2 — WEB_USERS tablosu için CRUD katmanı. login akışı (auth.ts), bootstrap admin
 * script'i (createAdminUser.ts) VE admin panelin "Kullanıcılar" sekmesi (adminUsers.ts route'u)
 * burayı kullanır. LDAP kullanıcı otomatik-oluşturma (Faz 2.4) da createLocalUser'ın YANINA,
 * ayrı bir createLdapUser benzeri fonksiyon olarak eklenecek.
 */

export type UserType = 'LOCAL' | 'LDAP';
export type UserRole = 'ADMIN' | 'MEMBER';

interface UserRow {
  USER_ID: number;
  USERNAME: string;
  USER_TYPE: UserType;
  PASSWORD_HASH: string | null;
  DISPLAY_NAME: string | null;
  ROLE: UserRole;
  CREATED_AT: Date;
}

export interface UserRecord {
  id: number;
  username: string;
  userType: UserType;
  /** LDAP kullanıcılarında her zaman null — bkz. 001_initial_schema.sql WEB_USERS tablosu dosya başı NOT. */
  passwordHash: string | null;
  displayName: string | null;
  role: UserRole;
  createdAt: string;
}

function mapRow(row: UserRow): UserRecord {
  return {
    id: row.USER_ID,
    username: row.USERNAME,
    userType: row.USER_TYPE,
    passwordHash: row.PASSWORD_HASH,
    displayName: row.DISPLAY_NAME,
    role: row.ROLE,
    createdAt: row.CREATED_AT.toISOString(),
  };
}

export async function getUserByUsername(username: string): Promise<UserRecord | undefined> {
  return withConnection(async (connection) => {
    const result = await connection.execute<UserRow>(
      `SELECT USER_ID, USERNAME, USER_TYPE, PASSWORD_HASH, DISPLAY_NAME, ROLE, CREATED_AT
       FROM WEB_USERS
       WHERE USERNAME = :username`,
      { username },
    );
    const row = result.rows?.[0];
    return row ? mapRow(row) : undefined;
  });
}

export async function getUserById(id: number): Promise<UserRecord | undefined> {
  return withConnection(async (connection) => {
    const result = await connection.execute<UserRow>(
      `SELECT USER_ID, USERNAME, USER_TYPE, PASSWORD_HASH, DISPLAY_NAME, ROLE, CREATED_AT
       FROM WEB_USERS
       WHERE USER_ID = :id`,
      { id },
    );
    const row = result.rows?.[0];
    return row ? mapRow(row) : undefined;
  });
}

export async function listUsers(): Promise<UserRecord[]> {
  return withConnection(async (connection) => {
    const result = await connection.execute<UserRow>(
      `SELECT USER_ID, USERNAME, USER_TYPE, PASSWORD_HASH, DISPLAY_NAME, ROLE, CREATED_AT
       FROM WEB_USERS
       ORDER BY CREATED_AT DESC`,
    );
    return (result.rows ?? []).map(mapRow);
  });
}

/** Şu an sistemde ROLE='ADMIN' olan kullanıcı sayısı — updateUserRole()'ün "son admin'i
 * düşüremezsin" güvenlik kontrolü için kullanılır. */
export async function countAdmins(): Promise<number> {
  return withConnection(async (connection) => {
    const result = await connection.execute<{ COUNT: number }>(
      `SELECT COUNT(*) AS COUNT FROM WEB_USERS WHERE ROLE = 'ADMIN'`,
    );
    return result.rows?.[0]?.COUNT ?? 0;
  });
}

/**
 * v3.0 Faz 2.2 — bir kullanıcının rolünü ADMIN <-> MEMBER arasında değiştirir. Güvenlik
 * kontrolleri (kendi kendini düşürememe, SON admin'i düşürememe) BİLİNÇLİ OLARAK burada DEĞİL,
 * çağıran route'ta (adminUsers.ts) yapılır — bu katman sadece "veritabanına yaz" sorumluluğunu
 * taşır, iş kuralı/yetki mantığını route katmanında tutuyoruz (bkz. projectStore/adminProjects
 * ile AYNI ayrım).
 */
export async function updateUserRole(id: number, role: UserRole): Promise<UserRecord> {
  return withConnection(async (connection) => {
    const result = await connection.execute(
      `UPDATE WEB_USERS SET ROLE = :role WHERE USER_ID = :id`,
      { role, id },
    );
    await connection.commit();

    if (!result.rowsAffected) {
      throw new NotFoundError(`Kullanıcı bulunamadı: ${id}`);
    }

    const row = await connection.execute<UserRow>(
      `SELECT USER_ID, USERNAME, USER_TYPE, PASSWORD_HASH, DISPLAY_NAME, ROLE, CREATED_AT
       FROM WEB_USERS
       WHERE USER_ID = :id`,
      { id },
    );
    const updated = row.rows?.[0];
    if (!updated) {
      throw new Error('Kullanıcı güncellendi ama okunamadı.');
    }
    return mapRow(updated);
  });
}

/**
 * v3.0 Faz 2.4 — bir LDAP kullanıcısı İLK KEZ başarıyla giriş yaptığında WEB_USERS tablosuna otomatik
 * eklenir (bkz. auth.ts /auth/login). ROLE HER ZAMAN 'MEMBER' — kullanıcının sohbette net belirttiği
 * kural: "giriş yapılan kişiler ilk önce default olarak normal user rolünde atanacak, admin isterse
 * admin yapacak" (bkz. adminUsers.ts — rol yükseltme/düşürme AYRI, mevcut bir uçtan yapılır).
 * PASSWORD_HASH BİLEREK NULL — LDAP kullanıcılarının şifresi bizim tarafımızda HİÇ SAKLANMAZ,
 * kimlik doğrulama HER GİRİŞTE yeniden LDAP sunucusuna karşı yapılır (bkz. ldapClient.ts).
 */
export interface CreateLdapUserInput {
  username: string;
  displayName: string | null;
}

export async function createLdapUser(input: CreateLdapUserInput): Promise<UserRecord> {
  return withConnection(async (connection) => {
    try {
      const result = await connection.execute<{ id: number[] }>(
        `INSERT INTO WEB_USERS (USERNAME, USER_TYPE, PASSWORD_HASH, DISPLAY_NAME, ROLE)
         VALUES (:username, 'LDAP', NULL, :displayName, 'MEMBER')
         RETURNING USER_ID INTO :id`,
        {
          username: input.username,
          displayName: input.displayName,
          id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        },
      );
      await connection.commit();

      const newId = result.outBinds?.id?.[0];
      if (newId === undefined) {
        throw new Error('LDAP kullanıcısı oluşturuldu ama yeni USER_ID okunamadı.');
      }

      const row = await connection.execute<UserRow>(
        `SELECT USER_ID, USERNAME, USER_TYPE, PASSWORD_HASH, DISPLAY_NAME, ROLE, CREATED_AT
         FROM WEB_USERS
         WHERE USER_ID = :id`,
        { id: newId },
      );
      const created = row.rows?.[0];
      if (!created) {
        throw new Error('LDAP kullanıcısı oluşturuldu ama okunamadı.');
      }
      return mapRow(created);
    } catch (err) {
      const oraError = err as { errorNum?: number };
      if (oraError.errorNum === 1) {
        // NEDEN burada hata YUTULMUYOR (createLocalUser'daki ValidationError'ın AKSİNE): bu satıra
        // düşülmesi, aynı username için iki eşzamanlı LDAP girişinin YARIŞA girdiği (race condition)
        // anlamına gelir — çağıran taraf (auth.ts) bunu yakalayıp kullanıcıyı TEKRAR getUserByUsername
        // ile okumalı (muhtemelen diğer istek zaten oluşturmuştur), sıradan bir "geçersiz giriş"
        // olarak GÖSTERİLMEMELİ.
        throw new ValidationError('Bu kullanıcı adı zaten kullanılıyor (LDAP otomatik oluşturma çakışması).');
      }
      throw err;
    }
  });
}

export interface CreateLocalUserInput {
  username: string;
  /** Ham şifre DEĞİL — çağıran taraf (createAdminUser.ts) auth/password.ts'deki hashPassword()
   * ile ÖNCEDEN hashlemiş olmalı. Bu katman kasıtlı olarak hashleme MANTIĞINI içermez. */
  passwordHash: string;
  displayName: string | null;
  role: UserRole;
}

/**
 * v3.0 Faz 5.3 — kullanıcı SİLME (bkz. sohbet notu: "user silme kısmı ekleyelim, eklediğim user'ın
 * şifresini unuttum" — yani asıl akış "sil, tekrar doğru şifreyle oluştur"). Güvenlik kontrolleri
 * (kendi kendini silememe, SON admin'i silememe) BİLİNÇLİ OLARAK burada DEĞİL, çağıran route'ta
 * (adminUsers.ts) — updateUserRole ile AYNI ayrım (bkz. o fonksiyonun dosya başı NOT'u).
 *
 * NOT — FK KISITLARI: WEB_PROJECTS.CREATED_BY / WEB_SCENARIOS.CREATED_BY / WEB_RUNS.STARTED_BY /
 * WEB_LDAP_CONFIG.UPDATED_BY / WEB_GLOBAL_SETTINGS.UPDATED_BY sütunları WEB_USERS'a FK'lidir ve BİLİNÇLİ OLARAK
 * "ON DELETE CASCADE" DEĞİLDİR (bkz. 001_initial_schema.sql — sadece WEB_PROJECT_MEMBERS CASCADE'dir).
 * Yani zaten proje/senaryo/koşum oluşturmuş ya da LDAP/Grid ayarını kaydetmiş bir kullanıcı
 * silinmeye çalışılırsa Oracle ORA-02292 (child record found) fırlatır — bunu ham haliyle
 * göstermek yerine anlaşılır bir ValidationError'a çeviriyoruz (bkz. aşağı).
 */
export async function deleteUser(id: number): Promise<void> {
  return withConnection(async (connection) => {
    try {
      const result = await connection.execute(`DELETE FROM WEB_USERS WHERE USER_ID = :id`, { id });
      await connection.commit();

      if (!result.rowsAffected) {
        throw new NotFoundError(`Kullanıcı bulunamadı: ${id}`);
      }
    } catch (err) {
      const oraError = err as { errorNum?: number };
      if (oraError.errorNum === 2292) {
        throw new ValidationError(
          'Bu kullanıcı silinemiyor çünkü adına kayıtlı proje/senaryo/koşum ya da kaydedilmiş bir ' +
            'ayar (LDAP/Grid URL) var — geçmiş kayıtların tutarlılığı için bu kısıtlanmıştır. ' +
            'Kullanıcıyı tamamen kaldırmak yerine rolünü MEMBER yapıp erişimini sınırlayabilirsiniz.',
        );
      }
      throw err;
    }
  });
}

export async function createLocalUser(input: CreateLocalUserInput): Promise<UserRecord> {
  return withConnection(async (connection) => {
    try {
      const result = await connection.execute<{ id: number[] }>(
        `INSERT INTO WEB_USERS (USERNAME, USER_TYPE, PASSWORD_HASH, DISPLAY_NAME, ROLE)
         VALUES (:username, 'LOCAL', :passwordHash, :displayName, :role)
         RETURNING USER_ID INTO :id`,
        {
          username: input.username,
          passwordHash: input.passwordHash,
          displayName: input.displayName,
          role: input.role,
          id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        },
      );
      await connection.commit();

      const newId = result.outBinds?.id?.[0];
      if (newId === undefined) {
        throw new Error('Kullanıcı oluşturuldu ama yeni USER_ID okunamadı.');
      }

      const row = await connection.execute<UserRow>(
        `SELECT USER_ID, USERNAME, USER_TYPE, PASSWORD_HASH, DISPLAY_NAME, ROLE, CREATED_AT
         FROM WEB_USERS
         WHERE USER_ID = :id`,
        { id: newId },
      );
      const created = row.rows?.[0];
      if (!created) {
        throw new Error('Kullanıcı oluşturuldu ama okunamadı.');
      }
      return mapRow(created);
    } catch (err) {
      const oraError = err as { errorNum?: number };
      if (oraError.errorNum === 1) {
        throw new ValidationError('Bu kullanıcı adı zaten kullanılıyor.');
      }
      throw err;
    }
  });
}
