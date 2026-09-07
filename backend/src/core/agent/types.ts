import type { BrowserContext } from 'playwright';
import type { RunReport, RunStatus, StepLogEntry } from '../../domain/types.js';
import type { BrowserManager } from '../browser/BrowserManager.js';

export type AgentEvent =
  | { type: 'run_started'; runId: string; url: string; scenario: string }
  | { type: 'step'; runId: string; step: StepLogEntry }
  | { type: 'run_finished'; runId: string; status: RunStatus; report: RunReport }
  | { type: 'run_error'; runId: string; message: string }
  // v2.2 — SADECE Selenium Grid kullanan bir run'da, tarayıcı başarıyla başlatıldıktan HEMEN
  // SONRA (bkz. AgentLoop.run — browserManager.launch() dönünce) yayınlanır; run_started'tan SONRA
  // gelir çünkü bu bilgi ancak Grid session'ı gerçekten açıldıktan sonra bilinebilir (bkz.
  // BrowserManager.getGridLiveViewUrl dosya başı açıklaması). Grid kullanılmıyorsa ya da noVNC
  // eşlemesi yoksa HİÇ yayınlanmaz.
  | { type: 'grid_live_view'; runId: string; url: string }
  // v2.4 — AgentLoop'un KENDİSİ bunu ASLA yayınlamaz; bu tamamen üst katmana (RunManager VEYA
  // LegacyTestService) ait sentetik bir olaydır (bkz. RunManager.startRunWithAutoRetry ve
  // LegacyTestService.runGeneratedTest). Bir "Replay (No AI)" denemesi 'replay_mismatch' ile
  // başarısız olduğunda — ister toplu/paralel çalıştırmada (Run Selected) ister tekli "Run"
  // butonunda — AYNI runId altında otomatik olarak tam AI modunda yeniden denenirken yayınlanır.
  // WS istemcisi bunu run'ın BİTTİĞİ anlamına gelmediğini bilmeli (gerçek 'run_finished' sadece
  // bu ikinci denemenin sonucunda gelir).
  | { type: 'replay_retry_started'; runId: string; reason: string }
  // v3.3 — SADECE AgentLoopInput.captureStorageState=true iken (ŞU AN SADECE Senaryo Önerileri'ndeki
  // login ön-adımı bunu kullanır — bkz. ScenarioSuggester.performLogin), context kapatılmadan HEMEN
  // ÖNCE yayınlanır. ÖNEMLİ: bu olay çerez/oturum verisi taşır (potansiyel olarak bir session
  // token içerir) — bu yüzden runManager.publishExternalEvent gibi genel bir WS yayın kanalına
  // bağlı bir onEvent ile ASLA dinlenmemelidir; SADECE performLogin'in kendi özel/yerel
  // dinleyicisiyle (dışarı hiçbir yere iletilmeyen) kullanılmalıdır.
  | { type: 'storage_state_captured'; runId: string; storageState: Awaited<ReturnType<BrowserContext['storageState']>> }
  // v3.42 — bkz. sohbet notu: ScenarioSuggester.performLogin() sonrası scanPage()'in `storageState`
  // (SADECE çerezler) ile SIFIRDAN yeni bir sayfa açıp ORİJİNAL url'e (login sayfası) dönmesi,
  // login senaryosunun içerdiği navigasyon/arama/seçim adımlarının (URL'e yansımayan TÜM DOM
  // durumunun) tamamen kaybolmasına yol açıyordu — kullanıcı "istenilen sayfa için senaryolar
  // çıkarılmıyor, sadece login sayfası için üretiyor" diye bildirdi. `AgentLoopInput.
  // handOffBrowserOnSuccess=true` VE run PASSED ile bittiyse, AgentLoop context'i KAPATMAK yerine
  // (bkz. AgentLoopInput dosya başı NOT'u) HALA AÇIK olan `browserManager`'ı bu olayla ÇAĞIRANA
  // devreder — çağıran artık AYNI, navigasyonun tam olarak bittiği sayfa üzerinde (page.goto()
  // OLMADAN) doğrudan tarama yapabilir, ve işi bitince browserManager.close()'u KENDİSİ çağırmakla
  // yükümlüdür (bkz. ScenarioSuggester.scanPage()). storage_state_captured olayındaki UYARI burada
  // da geçerlidir: genel bir WS yayın kanalına ASLA bağlanmamalıdır.
  | { type: 'browser_handed_off'; runId: string; browserManager: BrowserManager }
  // v3.51 — bkz. sohbet notu: "Scenario Definition sayfasındaki Execution Log panelinde Live
  // Streaming" özelliği. SADECE AgentLoopInput.enableLiveScreenshots=true iken (bkz. AgentLoop.run
  // — LIVE_SCREENSHOT_INTERVAL_MS aralığıyla) yayınlanır. `enableLiveScreenshots` YALNIZCA
  // LegacyTestService.generateAndRun() ve replayGeneratedTest() (yani TEKLİ "Run"/"Replay" akışları)
  // tarafından true olarak ayarlanır; RunManager.startRun/startRunWithAutoRetry (toplu/paralel
  // "Run Selected" akışı) kendi AgentLoopInput'unu SADECE sabit bir alan listesiyle (runId, url,
  // scenario, variables, secrets, options, replaySteps) oluşturduğundan bu event YAPISAL OLARAK
  // paralel koşumlarda asla üretilemez — bkz. RunManager dosya başı notu. Ekran görüntüsü küçük
  // boyutlu (düşük kaliteli JPEG) base64 olarak taşınır; herhangi bir çerez/oturum/gizli veri
  // İÇERMEZ, bu yüzden storage_state_captured/browser_handed_off'un aksine genel WS yayın kanalına
  // (runManager.publishExternalEvent → ws/runSocket.ts) bağlanması güvenlidir.
  | { type: 'live_frame'; runId: string; imageBase64: string; timestamp: string };

export type AgentEventListener = (event: AgentEvent) => void;
