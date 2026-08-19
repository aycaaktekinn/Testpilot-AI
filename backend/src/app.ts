import path from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import cors from 'cors';
import { healthRouter } from './api/routes/health.js';
import { runsRouter } from './api/routes/runs.js';
import { legacyTestsRouter } from './api/routes/legacyTests.js';
import { settingsRouter } from './api/routes/settings.js';
import { scenariosRouter } from './api/routes/scenarios.js';
import { allureRouter } from './api/routes/allure.js';
import { errorHandler } from './api/middleware/errorHandler.js';
import { env } from './config/env.js';
import { createLogger } from './config/logger.js';

const log = createLogger('app');

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  // Ekran görüntüsü / video / trace dosyaları (varsa) buradan sunulur; legacy adaptörünün
  // döndürdüğü "/artifacts/<runId>/..." URL'leri doğrudan bu klasöre eşlenir.
  app.use('/artifacts', express.static(path.resolve(env.ARTIFACTS_DIR)));

  // Yeni, generic, runId+WebSocket tabanlı API.
  app.use('/api', healthRouter);
  app.use('/api', runsRouter);

  // Mevcut (korunan) frontend'in beklediği eski API sözleşmesi — bkz. LegacyTestService.
  app.use('/api', legacyTestsRouter);

  // Yeni Settings sayfası için salt-okunur yapılandırma bilgisi.
  app.use('/api', settingsRouter);

  // URL'yi ziyaret edip AI destekli senaryo önerisi çıkaran uç nokta.
  app.use('/api', scenariosRouter);

  // Allure raporu üretme/durum sorgulama uç noktaları (bkz. AllureReportService).
  app.use('/api', allureRouter);

  // Üretilmiş Allure raporu (statik HTML) — "Generate Report" çalıştırılana kadar bu klasör boş
  // olabilir, o durumda Express doğal olarak 404 döner (frontend bunu /api/allure/status ile
  // önceden kontrol ediyor, bkz. app.js refreshAllureButtonsState()).
  app.use('/allure-report', express.static(path.resolve(env.ALLURE_REPORT_DIR)));

  // Frontend'i AYNI origin'den sunuyoruz: bu sayede app.js'teki fetch('/api/...') gibi göreli
  // istekler otomatik olarak bu backend'e gider — ayrı bir statik sunucuya veya CORS ayarına
  // gerek kalmaz. http://localhost:<PORT>/ adresini açmak yeterlidir.
  const frontendDir = path.resolve(env.FRONTEND_DIR);
  if (existsSync(frontendDir)) {
    app.use(express.static(frontendDir));
    log.info({ frontendDir }, 'Frontend statik dosyaları sunuluyor');
  } else {
    log.warn(
      { frontendDir },
      'FRONTEND_DIR bulunamadı; frontend bu backend üzerinden sunulmayacak (sadece API çalışır)',
    );
  }

  // Hata yakalayıcı EN SONDA olmalı — Express'te bir önceki middleware'lerden gelen next(err)
  // çağrılarını yakalayabilmesi için, ondan sonra kayıtlı hiçbir middleware olmamalıdır.
  app.use(errorHandler);

  return app;
}
