import { env } from '../config/env.js';
import { createLogger } from '../config/logger.js';
import { initOraclePool, closeOraclePool, withConnection } from './oracleClient.js';

const log = createLogger('renameWebTables');

/**
 * v3.1 — vakifbank PC ile tablo isimlerini eşitlemek için tek seferlik, elle çalıştırılan
 * bir yardımcı script. vakifbank PC'deki Oracle'da tablolar zaten WEB_ önekiyle yeniden
 * adlandırılmıştı (bkz. sohbet notu); bu script AYNI değişikliği Ayça MacBook Air'in KENDİ
 * ayrı/local Oracle instance'ında (Docker) uygular — kod tarafındaki WEB_ rename (bkz.
 * db/migrations/*.sql, src/db/*Store.ts) buraya paralel olarak zaten yapıldı.
 *
 * NEDEN idempotent: eski tablo adı zaten yoksa (ORA-00942 — daha önce bu script çalıştırılmış
 * ya da tablo hiç oluşturulmamış) o adımı atlayıp devam eder; script'i güvenle birden fazla
 * kez çalıştırmak mümkündür.
 *
 * Kullanım: npm run db:rename-web-tables
 */
const RENAMES: Array<{ from: string; to: string }> = [
  { from: 'PROJECT_MEMBERS', to: 'WEB_PROJECT_MEMBERS' },
  { from: 'GLOBAL_SETTINGS', to: 'WEB_GLOBAL_SETTINGS' },
  { from: 'LDAP_CONFIG', to: 'WEB_LDAP_CONFIG' },
  { from: 'SCENARIOS', to: 'WEB_SCENARIOS' },
  { from: 'PROJECTS', to: 'WEB_PROJECTS' },
  { from: 'USERS', to: 'WEB_USERS' },
  { from: 'RUNS', to: 'WEB_RUNS' },
];

async function renameWebTables(): Promise<void> {
  if (!env.ORACLE_DB_HOST) {
    throw new Error(
      'ORACLE_DB_HOST tanımlı değil — .env dosyanıza ORACLE_DB_* değişkenlerini ekleyin (bkz. .env.example)',
    );
  }

  await initOraclePool();

  try {
    await withConnection(async (connection) => {
      for (const { from, to } of RENAMES) {
        try {
          await connection.execute(`ALTER TABLE ${from} RENAME TO ${to}`);
          log.info({ from, to }, 'Tablo yeniden adlandırıldı');
          // eslint-disable-next-line no-console
          console.log(`OK   ${from} -> ${to}`);
        } catch (err) {
          const oraError = err as { errorNum?: number; message?: string };
          if (oraError.errorNum === 942) {
            // ORA-00942: table or view does not exist — ya zaten WEB_ ile yeniden adlandırılmış
            // (script daha önce çalıştırılmış) ya da bu tablo hiç oluşturulmamış.
            log.warn({ from, to }, 'Kaynak tablo bulunamadı (muhtemelen zaten yeniden adlandırılmış), atlanıyor');
            // eslint-disable-next-line no-console
            console.log(`SKIP ${from} -> ${to} (ORA-00942: ${from} bulunamadı, muhtemelen zaten yapılmış)`);
            continue;
          }
          throw err;
        }
      }
      await connection.commit();
    });

    log.info('Tüm tablo yeniden adlandırmaları tamamlandı');
    // eslint-disable-next-line no-console
    console.log('\nTüm tablo yeniden adlandırmaları tamamlandı.');
  } finally {
    await closeOraclePool();
  }
}

renameWebTables().catch((err) => {
  log.error({ err }, 'Tablo yeniden adlandırma başarısız oldu');
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
