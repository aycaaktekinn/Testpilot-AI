import { agentDecisionSchema } from '../actions/actionSchema.js';
import type { AgentDecision } from '../../domain/types.js';

/**
 * LLM'in döndürdüğü metni JSON olarak parse eder ve zod şemasına göre doğrular.
 * Modeller bazen JSON'ı ```json ... ``` bloğu içine sarabiliyor; bunu tolere ediyoruz.
 */
export function parseAgentDecision(raw: string): { ok: true; decision: AgentDecision } | { ok: false; error: string } {
  const cleaned = sanitizeBareUndefined(stripCodeFence(raw.trim()));

  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    return { ok: false, error: 'LLM yanıtı geçerli JSON değil' };
  }

  const result = agentDecisionSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }

  return { ok: true, decision: result.data };
}

function stripCodeFence(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();
  return text;
}

/**
 * Savunma amaçlı güvenlik ağı: bazı modeller, sistem promptunda örnek olarak gösterilen
 * TypeScript birleşim (union) sözdizimini ("string | undefined") birebir kopyalayıp bir alanın
 * değeri olarak çıplak (tırnaksız) `undefined` token'ı yazabiliyor — örn. `"value": undefined,`.
 * JSON standardında `undefined` diye bir değer YOKTUR (sadece `null` geçerlidir), bu yüzden
 * `JSON.parse` bunu reddediyordu. Asıl/kalıcı düzeltme PromptBuilder'daki talimatın modelin bu
 * hatayı yapmasını caydıracak şekilde güncellenmesidir; bu fonksiyon sadece modelin yine de aynı
 * hatayı yapması ihtimaline karşı bir ek güvenlik katmanıdır: değeri JSON açısından geçerli olan
 * `null`'a çeviriyoruz — actionSchema.ts'teki `.nullish()` tanımları bunu zaten doğru şekilde
 * "alan verilmemiş" anlamına gelecek şekilde `undefined`'a normalize ediyor.
 */
function sanitizeBareUndefined(text: string): string {
  return text.replace(/:\s*undefined\b/g, ': null');
}
