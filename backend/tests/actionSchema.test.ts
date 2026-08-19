import { describe, expect, it } from 'vitest';
import { agentDecisionSchema } from '../src/core/actions/actionSchema.js';
import { parseAgentDecision } from '../src/core/llm/ResponseParser.js';

describe('agentDecisionSchema', () => {
  it('geçerli bir click kararını kabul eder', () => {
    const result = agentDecisionSchema.safeParse({
      reasoning: 'Giriş butonuna tıklamalıyım',
      confidence: 0.9,
      action: 'click',
      targetRef: 'e3',
    });
    expect(result.success).toBe(true);
  });

  it('element gerektiren aksiyonda targetRef eksikse reddeder', () => {
    const result = agentDecisionSchema.safeParse({
      reasoning: 'tıklamalıyım',
      confidence: 0.9,
      action: 'click',
    });
    expect(result.success).toBe(false);
  });

  it('value gerektiren aksiyonda value eksikse reddeder', () => {
    const result = agentDecisionSchema.safeParse({
      reasoning: 'url git',
      confidence: 0.9,
      action: 'navigate',
    });
    expect(result.success).toBe(false);
  });

  it('finish_success için targetRef/value gerekmez', () => {
    const result = agentDecisionSchema.safeParse({
      reasoning: 'tamamlandı',
      confidence: 1,
      action: 'finish_success',
      summary: 'Senaryo başarıyla tamamlandı',
    });
    expect(result.success).toBe(true);
  });

  it('geçersiz ref formatını reddeder (halüsinasyon koruması)', () => {
    const result = agentDecisionSchema.safeParse({
      reasoning: 'x',
      confidence: 0.9,
      action: 'click',
      targetRef: 'button-submit', // "eN" formatında değil
    });
    expect(result.success).toBe(false);
  });
});

describe('parseAgentDecision', () => {
  it('```json kod bloğu içindeki JSON\'ı da parse edebilir', () => {
    const raw = '```json\n{"reasoning":"ok","confidence":0.8,"action":"finish_success","summary":"tamam"}\n```';
    const result = parseAgentDecision(raw);
    expect(result.ok).toBe(true);
  });

  it('geçersiz JSON için anlaşılır bir hata döner', () => {
    const result = parseAgentDecision('bu json değil');
    expect(result.ok).toBe(false);
  });
});
