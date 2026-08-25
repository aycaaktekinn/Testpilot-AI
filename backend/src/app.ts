import path from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import cors from 'cors';
import { healthRouter } from './api/routes/health.js';
import { runsRouter } from './api/routes/runs.js';
import { legacyTestsRouter } from './api/routes/legacyTests.js';
import { projectsRouter } from './api/routes/projects.js';
import { settingsRouter } from './api/routes/settings.js';
import { scenariosRouter } from './api/routes/scenarios.js';
import { allureRouter } from './api/routes/allure.js';
import { adminProjectsRouter } from './api/routes/adminProjects.js';
import { adminUsersRouter } from './api/routes/adminUsers.js';
import { adminLdapRouter } from './api/routes/adminLdap.js';
import { adminSettingsRouter } from './api/routes/adminSettings.js';
import { authRouter } from './api/routes/auth.js';
import { requireAuth } from './api/middleware/requireAuth.js';
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

  // v3.0 Faz 2.1 — login/logout/me. requireAuth İLE KORUNMAZ (bilerek) — aksi halde giriş
  // yapmadan önce "giriş yap" isteğinin kendisi 401 dönerdi. healthRouter da bilinçli olarak
  // AÇIK bırakıldı (izleme/health-check araçları genelde kimlik doğrulamasız çalışır).
  app.use('/api', authRouter);
  app.use('/api', healthRouter);

  // v3.0 Faz 2.1 — SİTE GENELİ GİRİŞ ZORUNLULUĞU: bu satırdan sonraki tüm /api router'ları
  // requireAuth arkasına alındı (bkz. requireAuth.ts dosya başı NOT). Rol farkı GÖZETMEZ — hem
  // admin hem member buradan geçer; proje bazlı görünürlük/izin Faz 4'te eklenecek. NOT — bu,
  // Oracle'ı artık FİİLEN zorunlu kılar: Oracle yapılandırılmadan hiç kimse login OLAMAZ (bkz.
  // auth.ts /auth/login 503'ü), dolayısıyla requireAuth'tan hiçbir istek geçemez.
  app.use('/api', requireAuth);

  // Yeni, generic, runId+WebSocket tabanlı API.
  app.use('/api', runsRouter);

  // Mevcut (korunan) frontend'in beklediği eski API sözleşmesi — bkz. LegacyTestService.
  app.use('/api', legacyTestsRouter);

  // v3.0 Faz 6 — Create Test sayfasındaki proje seçici için salt-okunur proje listesi (bkz.
  // projects.ts dosya başı NOT). requireAdmin İLE KORUNMAZ — herhangi bir giriş yapmış kullanıcı
  // erişebilir, zaten yukarıdaki site geneli requireAuth arkasında.
  app.use('/api', projectsRouter);

  // Yeni Settings sayfası için salt-okunur yapılandırma bilgisi.
  app.use('/api', settingsRouter);

  // URL'yi ziyaret edip AI destekli senaryo önerisi çıkaran uç nokta.
  app.use('/api', scenariosRouter);

  // Allure raporu üretme/durum sorgulama uç noktaları (bkz. AllureReportService).
  app.use('/api', allureRouter);

  // v3.0 — Admin Panel / Project CRUD (Faz 1) + Faz 2: requireAdmin ile korunuyor. Sıralama
  // BİLİNÇLİ: Oracle-yapılandırılmadı kontrolü requireAdmin'DEN ÖNCE, router'ın KENDİ İÇİNDE
  // çalışır (bkz. adminProjects.ts dosya başı NOT) — böylece Oracle kapalıyken kullanıcı "giriş
  // yapmalısın" yerine daha doğru olan "veritabanı yapılandırılmamış" mesajını görür.
  app.use('/api', adminProjectsRouter);

  // v3.0 Faz 2.2 — Admin Panel "Users" sekmesi (listele + rol değiştir). AYNI requireAdmin
  // deseni (kendi router'ının İÇİNDE, bkz. adminUsers.ts dosya başı NOT).
  app.use('/api', adminUsersRouter);

  // v3.0 Faz 2.3 — Admin Panel "LDAP" sekmesi (yapılandırmayı oku/kaydet). Gerçek LDAP BIND
  // doğrulaması BURADA YOK — sadece yapılandırma CRUD'u (bkz. adminLdap.ts dosya başı NOT).
  app.use('/api', adminLdapRouter);

  // v3.0 Faz 5 — Admin Panel'deki sabit/global Grid URL ayarı (bkz. adminSettings.ts dosya başı
  // NOT). AYNI requireAdmin deseni (kendi router'ının İÇİNDE).
  app.use('/api', adminSettingsRouter);

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
