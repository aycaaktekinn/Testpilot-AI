import { withConnection } from './oracleClient.js';

/**
 * v3.0 Faz 5 — GLOBAL_SETTINGS tablosu için DB katmanı (bkz. db/migrations/003_global_settings.sql
 * dosya başı NOT — TEK SATIR, CONFIG_ID her zaman 1, LDAP_CONFIG ile AYNI desen). Şu an sadece
 * Grid URL taşıyor; ileride proje bazlı OLMAYAN başka bir global ayar gerekirse buraya sütun
 * olarak eklenebilir.
 */

interface GlobalSettingsRow {
  CONFIG_ID: number;
  GRID_URL: string | null;
  UPDATED_AT: Date;
  UPDATED_BY: number | null;
}

export interface GlobalSettingsRecord {
  gridUrl: string | null;
  updatedAt: string;
  updatedBy: number | null;
}

function mapRow(row: GlobalSettingsRow): GlobalSettingsRecord {
  return {
    gridUrl: row.GRID_URL,
    updatedAt: row.UPDATED_AT.toISOString(),
    updatedBy: row.UPDATED_BY,
  };
}

const SELECT_COLUMNS = `CONFIG_ID, GRID_URL, UPDATED_AT, UPDATED_BY`;

/** Henüz hiç kaydedilmemişse (CONFIG_ID=1 satırı yoksa) undefined döner — çağıran taraf
 * (BrowserManager.resolveGridUrl) bunu ".env'e düş" sinyali olarak ele alır. */
export async function getGlobalSettings(): Promise<GlobalSettingsRecord | undefined> {
  return withConnection(async (connection) => {
    const result = await connection.execute<GlobalSettingsRow>(
      `SELECT ${SELECT_COLUMNS} FROM GLOBAL_SETTINGS WHERE CONFIG_ID = 1`,
    );
    const row = result.rows?.[0];
    return row ? mapRow(row) : undefined;
  });
}

export interface UpsertGlobalSettingsInput {
  gridUrl: string | null;
  updatedBy: number | null;
}

export async function upsertGlobalSettings(input: UpsertGlobalSettingsInput): Promise<GlobalSettingsRecord> {
  return withConnection(async (connection) => {
    await connection.execute(
      `MERGE INTO GLOBAL_SETTINGS target
       USING (SELECT 1 AS CONFIG_ID FROM DUAL) source
       ON (target.CONFIG_ID = source.CONFIG_ID)
       WHEN MATCHED THEN UPDATE SET
         GRID_URL = :gridUrl,
         UPDATED_AT = SYSTIMESTAMP,
         UPDATED_BY = :updatedBy
       WHEN NOT MATCHED THEN INSERT (CONFIG_ID, GRID_URL, UPDATED_BY)
       VALUES (1, :gridUrl, :updatedBy)`,
      { gridUrl: input.gridUrl, updatedBy: input.updatedBy },
    );
    await connection.commit();

    const result = await connection.execute<GlobalSettingsRow>(
      `SELECT ${SELECT_COLUMNS} FROM GLOBAL_SETTINGS WHERE CONFIG_ID = 1`,
    );
    const row = result.rows?.[0];
    if (!row) {
      throw new Error('Global ayarlar kaydedildi ama okunamadı.');
    }
    return mapRow(row);
  });
}
