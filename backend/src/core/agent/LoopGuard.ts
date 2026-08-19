import type { AgentDecision } from '../../domain/types.js';

interface RecordedAttempt {
  signature: string;
  stateHash: string;
}

/**
 * LoopGuard, ajanın sonsuz döngüye girmesini ya da faydasız tekrar yapmasını engeller.
 *
 * Tespit stratejisi: aynı (aksiyon + hedef + değer) imzası, sayfa durumu (stateHash) HİÇ
 * değişmeden art arda N kez tekrar edilirse, bu "takılma" (stuck) olarak kabul edilir ve
 * ajan güvenli şekilde FAIL ile durdurulur.
 */
export class LoopGuard {
  private history: RecordedAttempt[] = [];

  constructor(private readonly maxRepeats: number) {}

  /** Yeni bir aksiyon denemesini kaydeder ve döngüye girilip girilmediğini döner. */
  record(decision: AgentDecision, stateHash: string): { stuck: boolean; repeatCount: number } {
    const signature = `${decision.action}:${decision.targetRef ?? ''}:${decision.value ?? ''}`;
    this.history.push({ signature, stateHash });

    let repeatCount = 1;
    for (let i = this.history.length - 2; i >= 0; i--) {
      const entry = this.history[i];
      if (!entry) break;
      if (entry.signature === signature && entry.stateHash === stateHash) {
        repeatCount++;
      } else {
        break;
      }
    }

    return { stuck: repeatCount >= this.maxRepeats, repeatCount };
  }

  reset(): void {
    this.history = [];
  }
}
