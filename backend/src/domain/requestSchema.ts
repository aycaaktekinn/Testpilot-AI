import { z } from 'zod';

export const runOptionsInputSchema = z
  .object({
    maxSteps: z.number().int().positive().max(200).optional(),
    headless: z.boolean().optional(),
    stepTimeoutMs: z.number().int().positive().optional(),
    navigationTimeoutMs: z.number().int().positive().optional(),
    defaultActionTimeoutMs: z.number().int().positive().optional(),
    maxElementsPerStep: z.number().int().positive().max(300).optional(),
    maxRepeatedActions: z.number().int().min(2).max(10).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
    browserEngine: z.enum(['chromium', 'firefox', 'webkit']).optional(),
    captureScreenshot: z.boolean().optional(),
    captureVideo: z.boolean().optional(),
    captureTrace: z.boolean().optional(),
    // v2.0 — bkz. RunOptions.useSeleniumGrid dosya başı açıklaması (SADECE chromium ile geçerli).
    useSeleniumGrid: z.boolean().optional(),
  })
  .optional();

export const testRunRequestSchema = z.object({
  url: z.string().url('Geçerli bir URL giriniz'),
  scenario: z.string().min(3, 'Senaryo en az 3 karakter olmalı').max(8000),
  variables: z.record(z.string(), z.string()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  options: runOptionsInputSchema,
});

export type TestRunRequestInput = z.infer<typeof testRunRequestSchema>;

/**
 * v3.10 — "BDD" paneli: kullanıcının, otomatik üretilen (veya daha önce kendisinin kaydettiği)
 * özeti serbestçe düzenleyip kaydetmesi için. Boş metin de kabul edilir (kullanıcı paneli
 * temizleyebilir) — sadece üst sınır (8000, testRunRequestSchema.scenario ile tutarlı) var.
 */
export const bddDescriptionUpdateSchema = z.object({
  bddDescription: z.string().max(8000),
});

export type BddDescriptionUpdateInput = z.infer<typeof bddDescriptionUpdateSchema>;
