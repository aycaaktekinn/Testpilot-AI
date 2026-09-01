import { Router } from 'express';
import { z } from 'zod';
import { env, defaultRunOptions } from '../../config/env.js';
import {
  AgentSettingsStore,
  applyAgentSettingsOverride,
  resetAgentSettingsOverride,
} from '../../core/settings/AgentSettingsStore.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('settingsRoute');

export const settingsRouter = Router();
const agentSettingsStore = new AgentSettingsStore();

/**
 * Uygulama ayarları — frontend'in Settings sayfası için. AI Engine (API anahtarı dahil),
 * Selenium Grid ve Vector Cache bölümleri BİLİNÇLİ OLARAK salt-okunur kalır — değerler .env
 * dosyasından okunur, buradan HİÇ değiştirilemez (yanlış format sunucuyu bozabilir, API anahtarını
 * web arayüzünden değiştirmek secret'ı diskte/loglarda ifşa etme riski taşır — bkz. sohbet notu).
 *
 * v3.5 — "Agent Behavior" bölümü (maxSteps/minConfidence/timeout'lar/headless) İSTİSNADIR: bkz.
 * sohbet notu "koda gömülü ayarlar ... settings kısmından değiştirilebilir olsun" — bu alanlarda
 * HİÇBİR secret/kimlik bilgisi yok, yanlış bir değer en kötü ihtimalle bir sonraki test koşumunu
 * etkiler (geri alınabilir — bkz. PUT/POST /settings/agent/reset), bu yüzden AgentSettingsStore
 * (düz JSON dosyası, Oracle GEREKTİRMEZ) üzerinden düzenlenebilir hale getirildi.
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
    agent: agentSnapshot(),
    playwright: playwrightSnapshot(),
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

const agentSettingsSchema = z.object({
  maxSteps: z.coerce.number().int('Tam sayı olmalı').min(1).max(500).optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  stepTimeoutMs: z.coerce.number().int('Tam sayı olmalı').min(1000).optional(),
  maxElementsPerStep: z.coerce.number().int('Tam sayı olmalı').min(1).max(500).optional(),
  maxRepeatedActions: z.coerce.number().int('Tam sayı olmalı').min(1).optional(),
  navigationTimeoutMs: z.coerce.number().int('Tam sayı olmalı').min(1000).optional(),
  defaultActionTimeoutMs: z.coerce.number().int('Tam sayı olmalı').min(1000).optional(),
  headless: z.boolean().optional(),
});

/**
 * v3.5 — bkz. dosya başı NOT. Kısmi güncelleme: sadece gönderilen alanlar değişir, gönderilmeyen
 * alanlar (mevcut override'da olsun ya da olmasın) OLDUĞU GİBİ kalır. Kaydedilir kaydedilmez
 * AYNI istek içinde `applyAgentSettingsOverride()` ile defaultRunOptions'a da uygulanır — bir
 * sonraki test koşumundan itibaren (sunucu yeniden başlatılmadan) etkili olur.
 */
settingsRouter.put('/settings/agent', async (req, res) => {
  const parsed = agentSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: `Geçersiz ayar değeri: ${formatZodError(parsed.error)}` });
    return;
  }

  try {
    const current = await agentSettingsStore.get();
    const merged = { ...current, ...parsed.data };
    await agentSettingsStore.save(merged);
    applyAgentSettingsOverride(merged);
    res.status(200).json({ agent: agentSnapshot(), playwright: playwrightSnapshot() });
  } catch (err) {
    log.error({ err }, 'Agent Behavior ayarları kaydedilemedi');
    res.status(500).json({ message: 'Ayarlar kaydedilemedi.' });
  }
});

/** v3.5 — kayıtlı override'ı tamamen temizler ve defaultRunOptions'ı .env'den okunan orijinal
 * değerlere geri döndürür (bkz. AgentSettingsStore.resetAgentSettingsOverride). */
settingsRouter.post('/settings/agent/reset', async (_req, res) => {
  try {
    await agentSettingsStore.save({});
    resetAgentSettingsOverride();
    res.status(200).json({ agent: agentSnapshot(), playwright: playwrightSnapshot() });
  } catch (err) {
    log.error({ err }, 'Agent Behavior ayarları sıfırlanamadı');
    res.status(500).json({ message: 'Ayarlar sıfırlanamadı.' });
  }
});

function agentSnapshot() {
  return {
    maxSteps: defaultRunOptions.maxSteps,
    maxRepeatedActions: defaultRunOptions.maxRepeatedActions,
    minConfidence: defaultRunOptions.minConfidence,
    stepTimeoutMs: defaultRunOptions.stepTimeoutMs,
    maxElementsPerStep: defaultRunOptions.maxElementsPerStep,
  };
}

function playwrightSnapshot() {
  return {
    headless: defaultRunOptions.headless,
    navigationTimeoutMs: defaultRunOptions.navigationTimeoutMs,
    defaultActionTimeoutMs: defaultRunOptions.defaultActionTimeoutMs,
  };
}

function maskApiKey(key: string | undefined): string | null {
  if (!key) return null;
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}
