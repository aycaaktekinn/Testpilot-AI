import { describe, expect, it } from 'vitest';
import { LoopGuard } from '../src/core/agent/LoopGuard.js';
import type { AgentDecision } from '../src/domain/types.js';

function decision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    reasoning: 'test',
    confidence: 0.9,
    action: 'click',
    targetRef: 'e1',
    ...overrides,
  };
}

describe('LoopGuard', () => {
  it('sayfa durumu değişmeden aynı aksiyon N kez tekrar edilirse "stuck" bildirir', () => {
    const guard = new LoopGuard(3);

    expect(guard.record(decision(), 'hash-a').stuck).toBe(false);
    expect(guard.record(decision(), 'hash-a').stuck).toBe(false);
    expect(guard.record(decision(), 'hash-a').stuck).toBe(true);
  });

  it('sayfa durumu (stateHash) değişirse tekrar sayacı sıfırlanır', () => {
    const guard = new LoopGuard(3);

    expect(guard.record(decision(), 'hash-a').stuck).toBe(false);
    expect(guard.record(decision(), 'hash-a').stuck).toBe(false);
    expect(guard.record(decision(), 'hash-b').stuck).toBe(false);
    expect(guard.record(decision(), 'hash-b').stuck).toBe(false);
  });

  it('farklı aksiyonlar döngü olarak sayılmaz', () => {
    const guard = new LoopGuard(2);

    expect(guard.record(decision({ targetRef: 'e1' }), 'hash-a').stuck).toBe(false);
    expect(guard.record(decision({ targetRef: 'e2' }), 'hash-a').stuck).toBe(false);
    expect(guard.record(decision({ targetRef: 'e1' }), 'hash-a').stuck).toBe(false);
  });
});
