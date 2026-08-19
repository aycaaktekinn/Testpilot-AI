import type { RunReport, RunStatus, StepLogEntry } from '../../domain/types.js';

export type AgentEvent =
  | { type: 'run_started'; runId: string; url: string; scenario: string }
  | { type: 'step'; runId: string; step: StepLogEntry }
  | { type: 'run_finished'; runId: string; status: RunStatus; report: RunReport }
  | { type: 'run_error'; runId: string; message: string };

export type AgentEventListener = (event: AgentEvent) => void;
