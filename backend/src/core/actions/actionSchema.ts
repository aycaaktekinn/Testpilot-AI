import { z } from 'zod';
import { ACTION_TYPES } from '../../domain/types.js';

// v3.37 — bkz. sohbet notu: "Scenario Suggestions ... reasoning: String must contain at most 600
// character(s)" hatası. Bu üst sınırlar BİLEREK burada, TEK bir yerde, dışa açık sabitler olarak
// tanımlanıyor — ResponseParser.ts, zod bu limitlere göre REDDETMEDEN ÖNCE modelin ürettiği
// metni AYNI sayılarla kırpıyor (bkz. o dosyadaki NOT). Böylece limit iki yerde AYRI AYRI
// (ve potansiyel olarak birbirinden SAPMIŞ) sayı olarak durmuyor; tek kaynak burası.
export const MAX_REASONING_LENGTH = 600;
export const MAX_VALUE_LENGTH = 2000;
export const MAX_SUMMARY_LENGTH = 400;

export const agentDecisionSchema = z
  .object({
    reasoning: z.string().min(1).max(MAX_REASONING_LENGTH),
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
      .max(MAX_VALUE_LENGTH)
      .nullish()
      .transform((v) => v ?? undefined),
    summary: z
      .string()
      .max(MAX_SUMMARY_LENGTH)
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
