import { z } from 'zod';
import { ACTION_TYPES } from '../../domain/types.js';

export const agentDecisionSchema = z
  .object({
    reasoning: z.string().min(1).max(600),
    confidence: z.number().min(0).max(1),
    action: z.enum(ACTION_TYPES),
    // ÖNEMLİ: `.nullish()` kullanıyoruz (sadece `.optional()` DEĞİL) çünkü bazı modeller bu alanları
    // hiç yazmak yerine JSON çıktısında `null` (geçerli bir JSON değeri) olarak bırakabiliyor —
    // ör. "targetRef": null. `.nullish()` hem eksik alanı hem de `null` değerini kabul edip
    // `undefined`'a normalize eder; böylece koddaki geri kalan her yer (AgentDecision tipi vb.)
    // hâlâ sadece `string | undefined` ile uğraşır, `| null` her yere sızmaz.
    targetRef: z
      .string()
      .regex(/^e\d+$/)
      .nullish()
      .transform((v) => v ?? undefined),
    value: z
      .string()
      .max(2000)
      .nullish()
      .transform((v) => v ?? undefined),
    summary: z
      .string()
      .max(400)
      .nullish()
      .transform((v) => v ?? undefined),
  })
  .superRefine((decision, ctx) => {
    const needsTarget: string[] = [
      'click',
      'dblclick',
      'fill',
      'type',
      'select_option',
      'check',
      'uncheck',
      'hover',
      'scroll_into_view',
      'assert_visible',
    ];
    if (needsTarget.includes(decision.action) && !decision.targetRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${decision.action}" aksiyonu bir targetRef gerektirir`,
        path: ['targetRef'],
      });
    }

    const needsValue: string[] = ['fill', 'type', 'select_option', 'press_key', 'navigate', 'assert_text', 'assert_url', 'wait'];
    if (needsValue.includes(decision.action) && !decision.value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"${decision.action}" aksiyonu bir value gerektirir`,
        path: ['value'],
      });
    }
  });

export type AgentDecisionParsed = z.infer<typeof agentDecisionSchema>;
