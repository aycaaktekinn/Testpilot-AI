import { describe, expect, it } from 'vitest';
import { synthesizeTestCode } from '../src/core/legacy/codeSynthesizer.js';
import type { AgentDecision, RunReport, StepLogEntry } from '../src/domain/types.js';

/**
 * Kullanıcı tercihi (bkz. codeSynthesizer.ts dosya başı NOT): "Generated Code" panelinde SADECE
 * kod satırları görünsün, hiçbir yorum satırı ("//" ile başlayan hiçbir şey — adım açıklaması,
 * hata uyarısı, dosya başı NOT bloğu, "Sonuç:" satırı) OLMASIN. Bu test dosyası bu davranışı
 * doğrudan doğrular.
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

describe('synthesizeTestCode', () => {
  it('çıktıda HİÇ yorum satırı ("//") bulunmaz — normal, başarısız ve terminal adımlar dahil', () => {
    const code = synthesizeTestCode(
      report({
        status: 'failed',
        failureReason: 'ambiguous_step: bir şey oldu',
        steps: [
          step({ stepIndex: 0, decision: decision({ action: 'click', targetRef: 'e1' }), actionResult: { ok: true, message: 'Tıklandı: e1' } }),
          step({
            stepIndex: 1,
            decision: decision({ action: 'fill', targetRef: 'e2', value: 'kablosuz kulaklık' }),
            actionResult: { ok: false, message: 'Element bulunamadı', errorCode: 'ELEMENT_NOT_FOUND' },
          }),
          step({
            stepIndex: 2,
            decision: decision({ action: 'finish_failure', targetRef: undefined, summary: 'Senaryo tamamlanamadı' }),
            actionResult: { ok: true, message: 'Senaryo tamamlanamadı' },
          }),
        ],
      }),
    );

    const commentLines = code.split('\n').filter((line) => line.trim().startsWith('//') || line.trim().startsWith('*') || line.trim().startsWith('/**'));
    expect(commentLines).toEqual([]);
  });

  it('sadece import, test() sarmalayıcı, goto ve gerçek Playwright aksiyon satırlarını üretir', () => {
    const code = synthesizeTestCode(
      report({
        steps: [
          step({ decision: decision({ action: 'click', targetRef: 'e1' }) }),
          step({ decision: decision({ action: 'fill', targetRef: 'e2', value: 'laptop' }), actionResult: { ok: true, message: 'Dolduruldu: e2' } }),
        ],
      }),
    );

    expect(code).toContain(`import { test, expect } from '@playwright/test';`);
    expect(code).toContain(`await page.goto("https://example.com");`);
    expect(code).toContain(`await page.locator('[data-ai-ref="e1"]').click();`);
    expect(code).toContain(`await page.locator('[data-ai-ref="e2"]').fill("laptop");`);
    expect(code.trim().endsWith('});')).toBe(true);
  });

  it('terminal kararlar (finish_success/finish_failure/ask_clarification) için HİÇ satır üretmez (ne kod ne yorum)', () => {
    const code = synthesizeTestCode(
      report({
        steps: [
          step({ decision: decision({ action: 'click', targetRef: 'e1' }) }),
          step({ decision: decision({ action: 'finish_success', targetRef: undefined, summary: 'Tamamlandı' }) }),
        ],
      }),
    );

    const lines = code.split('\n').map((l) => l.trim()).filter(Boolean);
    // import + test(...) açılışı + goto + click + }); = 5 dolu satır, finish_success için EK satır yok.
    expect(lines).toHaveLength(5);
  });

  it('hiç adım yoksa sadece import/test iskeleti + goto döner', () => {
    const code = synthesizeTestCode(report());

    const lines = code.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(lines).toHaveLength(4);

    const commentLines = lines.filter((line) => line.startsWith('//') || line.startsWith('*') || line.startsWith('/**'));
    expect(commentLines).toEqual([]);
  });
});
