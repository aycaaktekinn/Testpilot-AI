import { createServer } from 'node:http';
import { createApp } from './app.js';
import { attachRunSocket } from './api/ws/runSocket.js';
import { env } from './config/env.js';
import { createLogger } from './config/logger.js';
import { initOraclePool, closeOraclePool } from './db/oracleClient.js';
import { legacyTestService } from './api/legacyTestServiceInstance.js';
import { AgentSettingsStore, applyAgentSettingsOverride } from './core/settings/AgentSettingsStore.js';

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

  // v3.2 — "gece test koşumu" zamanlaması (bkz. TestScheduler.ts dosya başı NOT). Oracle gibi
  // BİLİNÇLİ OLARAK best-effort: bir generated test'in index.json kaydı bozuksa/okunamazsa süreç
  // ÇÖKMEZ, sadece o zamanlama kurulamamış olur ve loglanır — geri kalan uygulama etkilenmez.
  try {
    await legacyTestService.initSchedules();
  } catch (err) {
    log.error({ err }, 'Zamanlanmış testler yüklenemedi — sunucu yine de başlatılıyor');
  }

  // v3.5 — Settings sayfasından değiştirilmiş "Agent Behavior" ayarları varsa (bkz.
  // AgentSettingsStore.ts dosya başı açıklaması), sunucu başlarken defaultRunOptions'a uygulanır.
  // Oracle/schedule yükleme ile AYNI best-effort felsefesi: dosya bozuksa/okunamazsa süreç
  // ÇÖKMEZ, sadece .env varsayılanlarıyla devam edilir.
  try {
    const agentSettingsOverride = await new AgentSettingsStore().get();
    applyAgentSettingsOverride(agentSettingsOverride);
  } catch (err) {
    log.error({ err }, 'Agent Behavior ayarları yüklenemedi — .env varsayılanları kullanılacak');
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
