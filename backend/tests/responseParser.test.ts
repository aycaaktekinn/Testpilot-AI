import { describe, expect, it } from 'vitest';
import { parseAgentDecision } from '../src/core/llm/ResponseParser.js';

describe('parseAgentDecision', () => {
  it('geçerli, düz JSON metnini doğru şekilde parse eder', () => {
    const raw = JSON.stringify({
      reasoning: 'Kullanıcı adı alanı e3 referansıyla bulundu',
      confidence: 0.9,
      action: 'click',
      targetRef: 'e3',
    });

    const result = parseAgentDecision(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.action).toBe('click');
      expect(result.decision.targetRef).toBe('e3');
      expect(result.decision.confidence).toBe(0.9);
    }
  });

  it('```json ... ``` kod bloğu içine sarılmış yanıtı tolere eder', () => {
    const raw = '```json\n' + JSON.stringify({ reasoning: 'ok', confidence: 0.8, action: 'go_back' }) + '\n```';

    const result = parseAgentDecision(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.action).toBe('go_back');
    }
  });

  it('başındaki/sonundaki fazladan boşlukları tolere eder', () => {
    const raw = '   \n' + JSON.stringify({ reasoning: 'ok', confidence: 0.8, action: 'go_back' }) + '\n   ';

    const result = parseAgentDecision(raw);

    expect(result.ok).toBe(true);
  });

  it('geçersiz JSON için ok:false ve açıklayıcı bir hata döner', () => {
    const result = parseAgentDecision('bu hiç JSON değil {{{');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/JSON/);
    }
  });

  it('zod şemasını ihlal eden (ör. click aksiyonu için targetRef eksik) JSON için ok:false döner ve alan adını içerir', () => {
    const raw = JSON.stringify({ reasoning: 'ok', confidence: 0.8, action: 'click' });

    const result = parseAgentDecision(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('targetRef');
    }
  });

  it('geçersiz confidence (>1) için ok:false döner', () => {
    const raw = JSON.stringify({ reasoning: 'ok', confidence: 1.5, action: 'go_back' });

    const result = parseAgentDecision(raw);

    expect(result.ok).toBe(false);
  });

  it('çıplak (tırnaksız) "undefined" token’ını, opsiyonel bir alan için otomatik olarak null’a çevirip kabul eder', () => {
    // Bazı modeller örnek TypeScript birleşim sözdizimini birebir kopyalayıp "value": undefined
    // yazabiliyor — bu standart JSON'da GEÇERSİZDİR. sanitizeBareUndefined() bunu null'a çevirir;
    // finish_success için summary zaten opsiyonel olduğundan bu, karar başarıyla parse edilmelidir.
    const raw = '{"reasoning": "tamamlandı", "confidence": 0.95, "action": "finish_success", "summary": undefined}';

    const result = parseAgentDecision(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.summary).toBeUndefined();
    }
  });

  it('targetRef/value/summary alanları JSON’da hiç yoksa (nullish) undefined olarak normalize edilir', () => {
    const raw = JSON.stringify({ reasoning: 'ok', confidence: 0.8, action: 'go_back' });

    const result = parseAgentDecision(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decision.targetRef).toBeUndefined();
      expect(result.decision.value).toBeUndefined();
      expect(result.decision.summary).toBeUndefined();
    }
  });

  it('targetRef beklenen "eN" formatına uymuyorsa ok:false döner', () => {
    const raw = JSON.stringify({ reasoning: 'ok', confidence: 0.9, action: 'click', targetRef: 'submit-button' });

    const result = parseAgentDecision(raw);

    expect(result.ok).toBe(false);
  });
});
