import { withConnection } from './oracleClient.js';
import { encryptSecret } from '../auth/secretCrypto.js';

/**
 * v3.0 Faz 2.3 — WEB_LDAP_CONFIG tablosu için DB katmanı (bkz. db/migrations/002_ldap_config.sql
 * dosya başı NOT — TEK SATIR, CONFIG_ID her zaman 1). Manager Password ASLA düz metin
 * SAKLANMAZ/DÖNÜLMEZ — bu katmanda encryptSecret() ile şifrelenerek yazılır; ÇÖZME (decrypt) İSE
 * BİLEREK BURADA DEĞİL, sadece gerçek LDAP bind denemesi yapılacağı yerde (Faz 2.4 — ldapClient.ts)
 * yapılacak. adminLdap.ts route'u bu yüzden şifreyi HİÇBİR ZAMAN client'a döndürmez, sadece
 * "configured" (boolean) bilgisini kullanır (bkz. settings.ts'teki API key maskeleme deseniyle AYNI
 * prensip).
 */

export type PasswordEncoderType = 'NO' | 'PLAIN' | 'SHA' | 'LDAP_SHA' | 'MD4' | 'MD5';

interface LdapConfigRow {
  CONFIG_ID: number;
  LDAP_URL: string | null;
  BASE_DN: string | null;
  MANAGER_DN: string | null;
  MANAGER_PASSWORD_ENCRYPTED: string | null;
  USER_DN_PATTERN: string | null;
  USER_SEARCH_FILTER: string | null;
  GROUP_SEARCH_BASE: string | null;
  GROUP_SEARCH_FILTER: string | null;
  PASSWORD_ENCODER_TYPE: PasswordEncoderType;
  UPDATED_AT: Date;
  UPDATED_BY: number | null;
}

export interface LdapConfigRecord {
  url: string | null;
  baseDn: string | null;
  managerDn: string | null;
  /** Şifreli ham değer — SADECE dahili kullanım için (ör. ileride ldapClient.ts'in decryptSecret()
   * ile çözmesi için). Route katmanı bunu ASLA client'a olduğu gibi döndürmemeli. */
  managerPasswordEncrypted: string | null;
  userDnPattern: string | null;
  userSearchFilter: string | null;
  groupSearchBase: string | null;
  groupSearchFilter: string | null;
  passwordEncoderType: PasswordEncoderType;
  updatedAt: string;
  updatedBy: number | null;
}

function mapRow(row: LdapConfigRow): LdapConfigRecord {
  return {
    url: row.LDAP_URL,
    baseDn: row.BASE_DN,
    managerDn: row.MANAGER_DN,
    managerPasswordEncrypted: row.MANAGER_PASSWORD_ENCRYPTED,
    userDnPattern: row.USER_DN_PATTERN,
    userSearchFilter: row.USER_SEARCH_FILTER,
    groupSearchBase: row.GROUP_SEARCH_BASE,
    groupSearchFilter: row.GROUP_SEARCH_FILTER,
    passwordEncoderType: row.PASSWORD_ENCODER_TYPE,
    updatedAt: row.UPDATED_AT.toISOString(),
    updatedBy: row.UPDATED_BY,
  };
}

const SELECT_COLUMNS = `
  CONFIG_ID, LDAP_URL, BASE_DN, MANAGER_DN, MANAGER_PASSWORD_ENCRYPTED,
  USER_DN_PATTERN, USER_SEARCH_FILTER, GROUP_SEARCH_BASE, GROUP_SEARCH_FILTER,
  PASSWORD_ENCODER_TYPE, UPDATED_AT, UPDATED_BY
`;

/** Henüz hiç kaydedilmemişse (CONFIG_ID=1 satırı yoksa) undefined döner. */
export async function getLdapConfig(): Promise<LdapConfigRecord | undefined> {
  return withConnection(async (connection) => {
    const result = await connection.execute<LdapConfigRow>(
      `SELECT ${SELECT_COLUMNS} FROM WEB_LDAP_CONFIG WHERE CONFIG_ID = 1`,
    );
    const row = result.rows?.[0];
    return row ? mapRow(row) : undefined;
  });
}

export interface UpsertLdapConfigInput {
  url: string | null;
  baseDn: string | null;
  managerDn: string | null;
  /** Ham (plaintext) şifre — SADECE değiştirilmek istendiğinde dolu gelir. undefined/null ise
   * mevcut şifrelenmiş değer AYNEN korunur (bkz. aşağıdaki NVL() kullanımı) — böylece admin panel
   * formunda "şifreyi boş bırak, değiştirme" davranışı, API anahtarı maskeleme deseniyle AYNI
   * şekilde çalışır. */
  managerPassword: string | null | undefined;
  userDnPattern: string | null;
  userSearchFilter: string | null;
  groupSearchBase: string | null;
  groupSearchFilter: string | null;
  passwordEncoderType: PasswordEncoderType;
  updatedBy: number | null;
}

export async function upsertLdapConfig(input: UpsertLdapConfigInput): Promise<LdapConfigRecord> {
  const managerPasswordEncrypted = input.managerPassword ? encryptSecret(input.managerPassword) : null;

  return withConnection(async (connection) => {
    await connection.execute(
      `MERGE INTO WEB_LDAP_CONFIG target
       USING (SELECT 1 AS CONFIG_ID FROM DUAL) source
       ON (target.CONFIG_ID = source.CONFIG_ID)
       WHEN MATCHED THEN UPDATE SET
         LDAP_URL = :url,
         BASE_DN = :baseDn,
         MANAGER_DN = :managerDn,
         MANAGER_PASSWORD_ENCRYPTED = NVL(:managerPasswordEncrypted, target.MANAGER_PASSWORD_ENCRYPTED),
         USER_DN_PATTERN = :userDnPattern,
         USER_SEARCH_FILTER = :userSearchFilter,
         GROUP_SEARCH_BASE = :groupSearchBase,
         GROUP_SEARCH_FILTER = :groupSearchFilter,
         PASSWORD_ENCODER_TYPE = :passwordEncoderType,
         UPDATED_AT = SYSTIMESTAMP,
         UPDATED_BY = :updatedBy
       WHEN NOT MATCHED THEN INSERT (
         CONFIG_ID, LDAP_URL, BASE_DN, MANAGER_DN, MANAGER_PASSWORD_ENCRYPTED,
         USER_DN_PATTERN, USER_SEARCH_FILTER, GROUP_SEARCH_BASE, GROUP_SEARCH_FILTER,
         PASSWORD_ENCODER_TYPE, UPDATED_BY
       ) VALUES (
         1, :url, :baseDn, :managerDn, :managerPasswordEncrypted,
         :userDnPattern, :userSearchFilter, :groupSearchBase, :groupSearchFilter,
         :passwordEncoderType, :updatedBy
       )`,
      {
        url: input.url,
        baseDn: input.baseDn,
        managerDn: input.managerDn,
        managerPasswordEncrypted,
        userDnPattern: input.userDnPattern,
        userSearchFilter: input.userSearchFilter,
        groupSearchBase: input.groupSearchBase,
        groupSearchFilter: input.groupSearchFilter,
        passwordEncoderType: input.passwordEncoderType,
        updatedBy: input.updatedBy,
      },
    );
    await connection.commit();

    const result = await connection.execute<LdapConfigRow>(
      `SELECT ${SELECT_COLUMNS} FROM WEB_LDAP_CONFIG WHERE CONFIG_ID = 1`,
    );
    const row = result.rows?.[0];
    if (!row) {
      throw new Error('LDAP yapılandırması kaydedildi ama okunamadı.');
    }
    return mapRow(row);
  });
}
