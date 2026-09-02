import type { LlmProvider } from './LlmProvider.js';
import type { RunReport, StepLogEntry } from '../../domain/types.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('BddDescriptionGenerator');

/**
 * v3.10 — "BDD" paneli için otomatik özet üretimi.
 *
 * ÖNEMLİ (güvenlik): Bu modüle giden HER ŞEY zaten maskelenmiş olmalıdır — `StepLogEntry.maskedValue`
 * ve `AgentDecision.value` secret referanslarını hep "{{secret.AD}}" placeholder'ı ya da "***" olarak
 * taşır, gerçek secret değeri asla bu katmana ulaşmaz (bkz. SecretsVault.maskForLog, RunLogger dosya
 * başı açıklaması, AgentDecision.value alan yorumu). Bu fonksiyon SADECE zaten maskelenmiş bu alanları
 * okur; hiçbir ek maskeleme/temizleme yapmaz çünkü buraya gelen veri zaten güvenli olmak ZORUNDADIR.
 *
 * Üretim best-effort'tur: LLM çağrısı herhangi bir sebeple başarısız olursa `undefined` döner —
 * bu run'ın PASSED/FAILED/ERROR durumunu HİÇBİR ŞEKİLDE etkilemez, sadece BDD paneli boş kalır ve
 * kullanıcı isterse elle doldurabilir.
 */

const MAX_STEPS_IN_PROMPT = 40;

function summarizeStepForPrompt(step: StepLogEntry): string {
  const { decision, actionResult, maskedValue } = step;
  const valuePart = maskedValue ? ` (değer: ${maskedValue})` : '';
  const targetPart = decision.targetRef ? ` [${decision.targetRef}]` : '';
  const outcome = actionResult.ok ? 'başarılı' : `başarısız: ${actionResult.message}`;
  return `${step.stepIndex + 1}. ${decision.action}${targetPart}${valuePart} — ${outcome}`;
}

const SYSTEM_MESSAGE = [
  'Sen bir test otomasyonu asistanısın. Sana bir test senaryosunun adım adım yürütme kaydı verilecek.',
  'Görevin bu kaydı, HER SATIRDA TEK bir eylem olacak şekilde, kısa Türkçe satırlar halinde özetlemek.',
  'Her satır kısa ve edilgen/geniş zaman kipiyle yazılmalı — örnek format:',
  'sayfa açılır',
  'elektronik kısmına tıklanır',
  'ürün adı arama kutusuna yazılır',
  'Bu örnekteki gibi: her satır küçük harfle başlar, sonunda nokta OLMAZ, satırlar arasında boş satır BIRAKMA.',
  'Kesinlikle numaralı liste ("1)", "2)" gibi) veya madde işareti ("-", "*") kullanma — SADECE düz satırlar.',
  'Kesinlikle klasik BDD Given/When/And/Then kalıbını (veya bunların Türkçe karşılıklarını, ör. "Diyelim ki", "Eğer", "O zaman") kullanma.',
  'Kesinlikle uzun, birbirine bağlı akıcı cümleler yazma — her adım kendi kısa satırında, ayrı ayrı dursun.',
  'Sadece verilen adım kaydındaki bilgileri kullan, uydurma detay ekleme. Önemsiz/teknik ara adımları atlayıp senaryonun akışını yansıtan anlamlı eylemlere odaklan.',
].join('\n');

export async function generateBddDescription(
  llm: LlmProvider,
  steps: StepLogEntry[],
  scenario: string,
  status: RunReport['status'],
): Promise<string | undefined> {
  if (steps.length === 0) return undefined;

  const stepLines = steps.slice(0, MAX_STEPS_IN_PROMPT).map(summarizeStepForPrompt).join('\n');
  const userMessage = [`Senaryo: ${scenario}`, `Sonuç: ${status}`, '', 'Adım kaydı:', stepLines].join('\n');

  try {
    const text = await llm.complete(
      [
        { role: 'system', content: SYSTEM_MESSAGE },
        { role: 'user', content: userMessage },
      ],
      { temperature: 0.3, maxTokens: 500 },
    );
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (err) {
    log.warn({ err }, 'BDD açıklaması üretilemedi (best-effort, run sonucunu etkilemez)');
    return undefined;
  }
}
