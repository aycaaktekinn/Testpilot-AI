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
  | { type: 'grid_live_view'; runId: string; url: string };

export type AgentEventListener = (event: AgentEvent) => void;
