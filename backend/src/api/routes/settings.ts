import { Router } from 'express';
import { env, defaultRunOptions } from '../../config/env.js';

export const settingsRouter = Router();

/**
 * Salt-okunur (read-only) uygulama ayarları — frontend'in yeni Settings sayfası için.
 * BİLİNÇLİ OLARAK sadece GET: bu endpoint'ten HİÇBİR yazma/değiştirme işlemi yapılmaz. Değerler
 * .env dosyasından okunur; web arayüzünden .env'e yazmak (API anahtarı dahil) ayrı, daha riskli
 * bir özellik olurdu (yanlış format sunucuyu bozabilir, secret'ları diskte/loglarda ifşa etme
 * riski taşır) — bu yüzden şimdilik BİLİNÇLİ OLARAK kapsam dışı bırakıldı.
 *
 * GÜVENLİK: gerçek API anahtarı değeri asla tam olarak döndürülmez — sadece "tanımlı mı" (boolean)
 * ve maskelenmiş bir önizleme (ör. "sk-o...a3f2") döner.
 */
settingsRouter.get('/settings', (_req, res) => {
  const apiKey = env.LLM_PROVIDER === 'openrouter' ? env.OPENROUTER_API_KEY : env.GEMINI_API_KEY;
  const model = env.LLM_PROVIDER === 'openrouter' ? env.OPENROUTER_MODEL : env.GEMINI_MODEL;

  res.status(200).json({
    llm: {
      provider: env.LLM_PROVIDER,
      model: model ?? null,
      apiKeyConfigured: Boolean(apiKey),
      apiKeyMasked: maskApiKey(apiKey),
    },
    agent: {
      maxSteps: defaultRunOptions.maxSteps,
      maxRepeatedActions: defaultRunOptions.maxRepeatedActions,
      minConfidence: defaultRunOptions.minConfidence,
      stepTimeoutMs: defaultRunOptions.stepTimeoutMs,
      maxElementsPerStep: defaultRunOptions.maxElementsPerStep,
    },
    playwright: {
      headless: defaultRunOptions.headless,
      navigationTimeoutMs: defaultRunOptions.navigationTimeoutMs,
      defaultActionTimeoutMs: defaultRunOptions.defaultActionTimeoutMs,
    },
  });
});

function maskApiKey(key: string | undefined): string | null {
  if (!key) return null;
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}
