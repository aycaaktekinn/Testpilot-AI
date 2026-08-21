import type { RunReport } from '../../domain/types.js';
import type { BddStepView } from '../../domain/legacyTypes.js';

/**
 * `codeSynthesizer.ts`'in tam tersi bir amaca hizmet eder: o dosya kod satırı üretir (terminal
 * kararları BİLEREK atlar), bu fonksiyon ise BDD-stil, insan-okunur bir adım listesi üretir ve
 * terminal kararları (finish_success/finish_failure/ask_clarification) DA dahil eder — kullanıcı
 * başarısız bir senaryonun tam olarak hangi adımda, neden durduğunu görebilsin diye (bkz.
 * BddStepView dosya başı açıklaması, "PASS/FAIL fark etmeksizin doldurulur").
 */
export function buildBddSteps(report: RunReport): BddStepView[] {
  return report.steps.map((step) => ({
    index: step.stepIndex,
    action: step.decision.action,
    // `summary` SADECE terminal kararlarda (ör. "Senaryo başarıyla tamamlandı") dolu olma
    // eğilimindedir ve o adımlar için `reasoning`'den daha sonuç-odaklı/okunaklıdır; diğer tüm
    // adımlarda `reasoning` zaten AI'nın o anki eylemi için verdiği doğal dil gerekçesidir.
    description: step.decision.summary?.trim() || step.decision.reasoning,
    ok: step.actionResult.ok,
  }));
}
