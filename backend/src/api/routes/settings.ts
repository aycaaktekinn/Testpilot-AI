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
  // v2.3 — LLM_PROVIDER="ollama" eklendi: OpenRouter/Gemini'nin AKSİNE yerelde çalışır, bir API
  // anahtarı KAVRAMI yoktur (bkz. OllamaProvider dosya başı açıklaması) — bu yüzden "configured"
  // burada "OLLAMA_MODEL tanımlı mı" anlamına gelir, "API anahtarı var mı" değil; frontend bunu
  // ayrıca ele alır (bkz. app.js).
  const apiKey =
    env.LLM_PROVIDER === 'openrouter'
      ? env.OPENROUTER_API_KEY
      : env.LLM_PROVIDER === 'gemini'
        ? env.GEMINI_API_KEY
        : undefined;
  const model =
    env.LLM_PROVIDER === 'openrouter'
      ? env.OPENROUTER_MODEL
      : env.LLM_PROVIDER === 'gemini'
        ? env.GEMINI_MODEL
        : env.OLLAMA_MODEL;

  res.status(200).json({
    llm: {
      provider: env.LLM_PROVIDER,
      model: model ?? null,
      // Ollama'da "API anahtarı" diye bir şey yok — "yapılandırılmış" burada onun yerine model
      // adının tanımlı olup olmadığını yansıtır (env.ts zaten LLM_PROVIDER="ollama" iken bunu
      // zorunlu kılıyor, ama defensif kalmak için burada da Boolean(model) ile kontrol ediyoruz).
      apiKeyConfigured: env.LLM_PROVIDER === 'ollama' ? Boolean(env.OLLAMA_MODEL) : Boolean(apiKey),
      apiKeyMasked: env.LLM_PROVIDER === 'ollama' ? null : maskApiKey(apiKey),
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
    // v2.0 — frontend'in "Selenium Grid üzerinden çalıştır" checkbox'ını, hub yapılandırılmamışken
    // devre dışı bırakabilmesi için (bkz. RunOptions.useSeleniumGrid / BrowserManager dosya başı
    // açıklamaları). Hub adresinin KENDİSİ BİLEREK dönülmez — bu sadece "yapılandırılmış mı"
    // bilgisidir, herhangi bir sırrı ifşa etmez ama yine de dahili altyapı adresidir.
    seleniumGrid: {
      configured: Boolean(env.SELENIUM_GRID_URL),
    },
    // v2.0 Faz 3 — vector cache (locator cache / Milvus+Ollama) yapılandırma durumu (bkz.
    // VectorCacheStore ve AgentLoop.tryVectorCacheHit dosya başı açıklamaları). Selenium Grid ile
    // AYNI prensip: sadece "yapılandırılmış mı" bilgisi + hassas OLMAYAN eşik/model bilgileri
    // döner — Milvus/Ollama adresleri (MILVUS_URL/OLLAMA_URL) BİLEREK dönülmez, tıpkı hub
    // adresinin dönülmediği gibi (bunlar dahili altyapı adresleridir, sır DEĞİLDİR ama yine de
    // API'nin dışarı sızdırması gereken bir bilgi değildir).
    vectorCache: {
      writeEnabled: env.VECTOR_CACHE_ENABLED,
      readEnabled: env.VECTOR_CACHE_READ_ENABLED,
      embeddingModel: env.OLLAMA_EMBEDDING_MODEL ?? null,
      minSimilarity: env.VECTOR_CACHE_MIN_SIMILARITY,
    },
  });
});

function maskApiKey(key: string | undefined): string | null {
  if (!key) return null;
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}
