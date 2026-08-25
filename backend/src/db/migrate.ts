import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { createLogger } from '../config/logger.js';
import { initOraclePool, closeOraclePool, withConnection } from './oracleClient.js';

const log = createLogger('migrate');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// backend/db/migrations — bu dosya backend/src/db/migrate.ts'de yaşadığı için iki seviye yukarı.
const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

/**
 * v3.0 — `db/migrations/*.sql` altındaki dosyaları DOSYA ADI SIRASINA göre (ör. 001_, 002_, ...)
 * tek tek okuyup Oracle'a karşı çalıştıran basit bir migration runner. Bir "migration geçmişi"
 * tablosu (ör. SCHEMA_MIGRATIONS) BİLİNÇLİ OLARAK Faz 0'da eklenmedi — şu an tek migration dosyası
 * var ve amaç "boş bir veritabanında tabloları bir kere oluşturmak"; ileride migration sayısı
 * artarsa (Faz 5 — Agent Behavior sütunları vb.) "hangi migration'lar zaten çalıştı" takibi ayrıca
 * eklenecek.
 *
 * NEDEN yorum satırlarını SPLIT'TEN ÖNCE tüm metinden çıkarıyoruz (satır satır), CHUNK'LARA
 * BÖLDÜKTEN SONRA değil: bir chunk "-- açıklama\nCREATE TABLE ..." şeklinde bir yorum bloğuyla
 * BAŞLIYORSA, chunk'ın TAMAMINI yorum sanıp atlama hatasına düşülebiliyor. Bunun yerine önce HER
 * satırı tek tek süzüp yorum satırlarını (trim sonrası "--" ile başlayanları) kaldırıyoruz, ANCAK
 * satır SONU yorumları (ör. "SOME_COL NUMBER, -- açıklama") KORUNUYOR çünkü onlar zaten aynı satırda
 * gerçek SQL içeriyor — sadece SATIRIN TAMAMI yorum olan satırlar atılıyor.
 */
async function loadStatements(sqlFileContent: string): Promise<string[]> {
  const withoutFullLineComments = sqlFileContent
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  return withoutFullLineComments
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
}

async function runMigrations(): Promise<void> {
  if (!env.ORACLE_DB_HOST) {
    throw new Error(
      'ORACLE_DB_HOST tanımlı değil — .env dosyanıza ORACLE_DB_* değişkenlerini ekleyin (bkz. .env.example)',
    );
  }

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  if (files.length === 0) {
    log.warn({ dir: MIGRATIONS_DIR }, 'Hiç migration dosyası bulunamadı');
    return;
  }

  await initOraclePool();

  try {
    for (const file of files) {
      const fullPath = path.join(MIGRATIONS_DIR, file);
      const content = await readFile(fullPath, 'utf-8');
      const statements = await loadStatements(content);

      log.info({ file, statementCount: statements.length }, 'Migration çalıştırılıyor');

      await withConnection(async (connection) => {
        for (const statement of statements) {
          try {
            await connection.execute(statement);
          } catch (err) {
            // ORA-00955: "name is already used by an existing object" — tablo/index zaten varsa
            // (migration ikinci kez çalıştırıldıysa) bu statement'ı atla, script'in geri kalanını
            // durdurma. Başka herhangi bir hata olduğu gibi fırlatılmaya devam eder.
            const oraError = err as { errorNum?: number; message?: string };
            if (oraError.errorNum === 955) {
              log.warn({ file, statement: statement.slice(0, 80) }, 'Nesne zaten var, atlanıyor (ORA-00955)');
              continue;
            }
            throw err;
          }
        }
        await connection.commit();
      });

      log.info({ file }, 'Migration tamamlandı');
    }

    log.info('Tüm migration\'lar başarıyla tamamlandı');
  } finally {
    await closeOraclePool();
  }
}

runMigrations().catch((err) => {
  log.error({ err }, 'Migration başarısız oldu');
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
