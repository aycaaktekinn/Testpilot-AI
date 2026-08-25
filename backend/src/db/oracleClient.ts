import oracledb from 'oracledb';
import { env } from '../config/env.js';
import { createLogger } from '../config/logger.js';

const log = createLogger('oracleClient');

/**
 * v3.0 — Admin panel / Projects / Users / Runs geçmişi için Oracle Database bağlantı havuzu.
 *
 * NEDEN "Thin mode" (varsayılan): oracledb v6+, HİÇBİR Oracle Instant Client kurulumu
 * GEREKTİRMEDEN saf JavaScript üzerinden Oracle'a bağlanabilir (bkz. sohbet notu — kullanıcının
 * Oracle konusunda hiç deneyimi yoktu, bu yüzden bilinçli olarak "Thick mode" — ki bu ayrı bir
 * Instant Client kurulumu ister — HİÇ kullanılmıyor). `oracledb.initOracleClient()` çağrısı
 * BİLEREK YAPILMIYOR — o çağrı Thick mode'a geçiş anlamına gelir.
 *
 * NEDEN tek bir modül üzerinden paylaşılan havuz: her sorgu için yeni bir bağlantı açmak
 * pahalıdır ve Oracle sunucusunu gereksiz yere yorar. Bu modül `initOraclePool()` ile UYGULAMA
 * BAŞLANGICINDA bir kez havuz açar, `withConnection()` ile havuzdan ödünç alıp iş bitince
 * OTOMATİK geri bırakır (try/finally) — çağıran kod asla connection.close() unutma riskiyle
 * karşılaşmaz.
 *
 * NEDEN opsiyonel: ORACLE_DB_HOST tanımlı değilse (bkz. env.ts) bu modül hiç import edilmemeli/
 * çağrılmamalı — Oracle katmanı olmadan da bugünkü JSON dosya tabanlı akış tamamen çalışır durumda
 * kalmalı (admin panel özelliği kademeli devreye alınıyor, bkz. Faz 0-6 planı).
 */

let pool: oracledb.Pool | null = null;

/** Havuzu açar. Uygulama başlangıcında (index.ts) BİR KEZ çağrılmalıdır. */
export async function initOraclePool(): Promise<void> {
  if (pool) {
    log.warn('initOraclePool() zaten açık bir havuz varken tekrar çağrıldı, atlanıyor');
    return;
  }

  // Satırları varsayılan (konumsal) DİZİ yerine { SUTUN_ADI: değer } şeklinde NESNE olarak
  // döndürür — store katmanındaki (ör. projectStore.ts) mapRow() fonksiyonları bu yüzden
  // row[0], row[1]... yerine row.PROJECT_ID, row.PROJECT_NAME gibi okunabilir alan adları kullanır.
  oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

  if (!env.ORACLE_DB_HOST) {
    throw new Error(
      'initOraclePool() çağrıldı ama ORACLE_DB_HOST tanımlı değil — çağırmadan önce env.ORACLE_DB_HOST kontrolü yapın',
    );
  }

  const connectString = `${env.ORACLE_DB_HOST}:${env.ORACLE_DB_PORT}/${env.ORACLE_DB_SERVICE_NAME}`;

  pool = await oracledb.createPool({
    user: env.ORACLE_DB_USER,
    password: env.ORACLE_DB_PASSWORD,
    connectString,
    poolMin: 1,
    poolMax: 10,
    poolIncrement: 1,
  });

  log.info({ connectString, user: env.ORACLE_DB_USER }, 'Oracle bağlantı havuzu açıldı');
}

/** Açık havuzu döner; initOraclePool() önceden çağrılmamışsa hata fırlatır. */
export function getOraclePool(): oracledb.Pool {
  if (!pool) {
    throw new Error('Oracle havuzu henüz açılmadı — önce initOraclePool() çağrılmalı');
  }
  return pool;
}

/**
 * Havuzdan bir bağlantı ödünç alır, verilen fonksiyonu çalıştırır, SONUÇ NE OLURSA OLSUN
 * (başarı/hata) bağlantıyı havuza geri bırakır. Sorgu/DML yazan kod her zaman BUNUN üzerinden
 * geçmelidir — doğrudan pool.getConnection() çağırıp elle close() yapmak yerine.
 */
export async function withConnection<T>(fn: (connection: oracledb.Connection) => Promise<T>): Promise<T> {
  const activePool = getOraclePool();
  const connection = await activePool.getConnection();
  try {
    return await fn(connection);
  } finally {
    try {
      await connection.close();
    } catch (err) {
      log.warn({ err }, 'Oracle bağlantısı havuza geri bırakılırken hata (görmezden gelindi)');
    }
  }
}

/** Uygulama kapanışında (graceful shutdown) havuzu düzgünce kapatır. */
export async function closeOraclePool(): Promise<void> {
  if (!pool) return;
  await pool.close(10); // bekleyen işlemler için 10sn tolerans
  pool = null;
  log.info('Oracle bağlantı havuzu kapatıldı');
}
