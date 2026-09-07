import { agentDecisionSchema, MAX_REASONING_LENGTH, MAX_VALUE_LENGTH, MAX_SUMMARY_LENGTH } from '../actions/actionSchema.js';
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

  // v3.37 — bkz. sohbet notu: "Scenario Suggestions ... reasoning: String must contain at most
  // 600 character(s)" hatası. Karmaşık/kalabalık sayfalarda (ör. onlarca linkli bir "Tüm
  // İşlemler" menüsü) model bazen kararını AÇIKLARKEN çok uzun bir metin yazıyor — bu alan
  // SADECE teşhis/log amaçlıdır, aksiyonun kendisini (targetRef/value/action) HİÇ etkilemez, bu
  // yüzden zod'un tüm kararı REDDETMESİNE (ve MAX_LLM_RETRIES_PER_STEP'i aynı sebeple tüketip
  // koşumun tamamen başarısız olmasına — canlıda gözlemlenen tam olarak buydu) izin vermek yerine,
  // doğrulamadan ÖNCE burada sessizce kırpıyoruz. Aynı savunma value/summary için de uygulanıyor
  // (ikisi de model tarafından yazılan serbest metin, aynı riski taşıyor).
  truncateStringField(json, 'reasoning', MAX_REASONING_LENGTH);
  truncateStringField(json, 'value', MAX_VALUE_LENGTH);
  truncateStringField(json, 'summary', MAX_SUMMARY_LENGTH);

  const result = agentDecisionSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }

  return { ok: true, decision: result.data };
}

function truncateStringField(json: unknown, field: string, maxLength: number): void {
  if (
    json !== null &&
    typeof json === 'object' &&
    field in json &&
    typeof (json as Record<string, unknown>)[field] === 'string'
  ) {
    const current = (json as Record<string, unknown>)[field] as string;
    if (current.length > maxLength) {
      (json as Record<string, unknown>)[field] = current.slice(0, maxLength);
    }
  }
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
