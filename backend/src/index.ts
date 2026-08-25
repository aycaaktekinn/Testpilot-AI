import { createServer } from 'node:http';
import { createApp } from './app.js';
import { attachRunSocket } from './api/ws/runSocket.js';
import { env } from './config/env.js';
import { createLogger } from './config/logger.js';
import { initOraclePool, closeOraclePool } from './db/oracleClient.js';

const log = createLogger('server');

async function main() {
  // v3.0 — Oracle katmanı OPSİYONELDİR (bkz. env.ts ORACLE_DB_HOST açıklaması): tanımlı değilse
  // hiç dokunulmaz, uygulamanın geri kalanı (JSON dosya tabanlı akış) her zamanki gibi çalışır.
  // Tanımlıyken havuz açılamazsa (ör. container henüz ayağa kalkmadı) BİLİNÇLİ OLARAK süreç
  // ÇÖKMEZ — sadece loglanır; admin panel/Oracle uçları o durumda 500 döner ama Playwright/AI
  // test akışı bundan hiç etkilenmez.
  if (env.ORACLE_DB_HOST) {
    try {
      await initOraclePool();
    } catch (err) {
      log.error({ err }, 'Oracle bağlantı havuzu açılamadı — admin panel uçları çalışmayacak, geri kalan uygulama etkilenmeyecek');
    }
  }

  const app = createApp();
  const server = createServer(app);
  attachRunSocket(server);

  server.listen(env.PORT, () => {
    log.info(`AI Playwright Automation backend ${env.PORT} portunda çalışıyor (env=${env.NODE_ENV})`);
  });

  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, 'Yakalanmamış promise reddi');
  });

  process.on('SIGTERM', () => {
    log.info('SIGTERM alındı, sunucu kapatılıyor');
    server.close(() => {
      void closeOraclePool().finally(() => process.exit(0));
    });
  });
}

main();
