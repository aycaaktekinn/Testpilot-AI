import type { BrowserContext } from 'playwright';
import type { RunReport, RunStatus, StepLogEntry } from '../../domain/types.js';

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
  | { type: 'storage_state_captured'; runId: string; storageState: Awaited<ReturnType<BrowserContext['storageState']>> };

export type AgentEventListener = (event: AgentEvent) => void;
