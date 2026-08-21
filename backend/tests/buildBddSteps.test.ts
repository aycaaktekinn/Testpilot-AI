import { describe, expect, it } from 'vitest';
import { buildBddSteps } from '../src/core/legacy/buildBddSteps.js';
import type { AgentDecision, RunReport, StepLogEntry } from '../src/domain/types.js';

/**
 * codeSynthesizer.test.ts ile aynı fixture desenini kullanır (bkz. o dosyanın dosya başı NOT'u)
 * — ama burada TERSİ bir davranış doğrulanıyor: terminal kararlar da DAHİL, TÜM adımlar BDD
 * görünümünde yer almalı (bkz. buildBddSteps.ts dosya başı açıklaması).
 */

function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return { reasoning: 'test gerekçesi', confidence: 0.9, action: 'click', targetRef: 'e1', ...overrides };
}

function step(overrides: Partial<StepLogEntry> = {}): StepLogEntry {
  return {
    stepIndex: 0,
    timestamp: '2026-08-18T00:00:00.000Z',
    url: 'https://example.com',
    decision: decision(),
    actionResult: { ok: true, message: 'Tıklandı: e1' },
    durationMs: 100,
    ...overrides,
  };
}

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    runId: 'r-1',
    status: 'passed',
    url: 'https://example.com',
    scenario: 'Örnek senaryo',
    startedAt: '2026-08-18T00:00:00.000Z',
    totalSteps: 0,
    llmCallCount: 0,
    steps: [],
    ...overrides,
  };
}

describe('buildBddSteps', () => {
  it('her StepLogEntry için index/action/ok alanlarını birebir taşır', () => {
    const steps = buildBddSteps(
      report({
        steps: [
          step({ stepIndex: 0, decision: decision({ action: 'click', targetRef: 'e1' }), actionResult: { ok: true, message: 'Tıklandı: e1' } }),
          step({
            stepIndex: 1,
            decision: decision({ action: 'fill', targetRef: 'e2', value: 'kablosuz kulaklık' }),
            actionResult: { ok: false, message: 'Element bulunamadı', errorCode: 'ELEMENT_NOT_FOUND' },
          }),
        ],
      }),
    );

    expect(steps).toEqual([
      { index: 0, action: 'click', description: 'test gerekçesi', ok: true },
      { index: 1, action: 'fill', description: 'test gerekçesi', ok: false },
    ]);
  });

  it('terminal kararları (finish_success/finish_failure/ask_clarification) DA içerir — codeSynthesizer\'ın aksine hiçbir adımı atlamaz', () => {
    const steps = buildBddSteps(
      report({
        status: 'failed',
        steps: [
          step({ stepIndex: 0, decision: decision({ action: 'click', targetRef: 'e1' }) }),
          step({
            stepIndex: 1,
            decision: decision({ action: 'finish_failure', targetRef: undefined, summary: 'Senaryo tamamlanamadı' }),
            actionResult: { ok: true, message: 'Senaryo tamamlanamadı' },
          }),
        ],
      }),
    );

    expect(steps).toHaveLength(2);
    expect(steps[1]).toEqual({ index: 1, action: 'finish_failure', description: 'Senaryo tamamlanamadı', ok: true });
  });

  it('summary doluysa description olarak summary\'yi, boşsa reasoning\'i kullanır', () => {
    const steps = buildBddSteps(
      report({
        steps: [
          step({ stepIndex: 0, decision: decision({ reasoning: 'gerekçe metni', summary: undefined }) }),
          step({ stepIndex: 1, decision: decision({ reasoning: 'gerekçe metni', summary: 'özet metni' }) }),
          step({ stepIndex: 2, decision: decision({ reasoning: 'gerekçe metni', summary: '   ' }) }),
        ],
      }),
    );

    expect(steps[0]?.description).toBe('gerekçe metni');
    expect(steps[1]?.description).toBe('özet metni');
    // Sadece boşluklardan oluşan bir summary, boş sayılıp reasoning'e düşmeli.
    expect(steps[2]?.description).toBe('gerekçe metni');
  });

  it('hiç adım yoksa boş dizi döner', () => {
    expect(buildBddSteps(report())).toEqual([]);
  });
});
