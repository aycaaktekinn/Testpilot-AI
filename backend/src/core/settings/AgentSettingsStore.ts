import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env, defaultRunOptions } from '../../config/env.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('AgentSettingsStore');

/**
 * v3.5 — bkz. sohbet notu: "koda gömülü ayarlar ... settings kısmından değiştirilebilir formata
 * getirebilir miyiz". Settings sayfasındaki "Agent Behavior" alanları (maxSteps, minConfidence,
 * timeout'lar, headless vb.) ÖNCEDEN SADECE .env üzerinden, sunucu yeniden başlatılarak
 * değiştirilebiliyordu (bkz. defaultRunOptions, config/env.ts). Bu dosya, BİLİNÇLİ OLARAK Oracle'a
 * DEĞİL (globalSettingsStore.ts'in — Admin Panel'in Global Grid URL ayarının — aksine) düz bir
 * JSON dosyasına yazar: bu özelliğin asıl hedef kitlesi (agent davranışını ayarlamak isteyen
 * herkes) Oracle yapılandırmış olmak ZORUNDA değil — TestRunStore/GeneratedTestStore ile AYNI
 * "her zaman çalışır" desen izlenir.
 *
 * Kaydedilen değer sadece bir "override" (kısmi — sadece kullanıcının Settings sayfasından
 * DEĞİŞTİRDİĞİ alanlar) — hiç kaydedilmemiş bir alan .env'deki (ya da onun da tanımlamadığı zod
 * varsayılanına) değere geri döner (bkz. applyAgentSettingsOverride()).
 */
export interface AgentSettingsOverride {
  maxSteps?: number;
  minConfidence?: number;
  stepTimeoutMs?: number;
  maxElementsPerStep?: number;
  maxRepeatedActions?: number;
  navigationTimeoutMs?: number;
  defaultActionTimeoutMs?: number;
  headless?: boolean;
}

// Hangi alanların GEÇERLİ bir override alanı olduğu — hem okurken (bozuk/eski/elle düzenlenmiş
// bir dosyadaki tanınmayan alanları sessizce atmak için) hem defaultRunOptions'a uygularken
// kullanılır. defaultRunOptions'ın TÜMÜNÜ değil, SADECE bu listedeki alanları kapsar — ör.
// `viewport`/`browserEngine`/`captureScreenshot` gibi alanlar bu özelliğin kapsamı DIŞINDADIR
// (bkz. sohbet notu: sadece "Agent Behavior" bölümü kapsama alındı).
const ALLOWED_KEYS = [
  'maxSteps',
  'minConfidence',
  'stepTimeoutMs',
  'maxElementsPerStep',
  'maxRepeatedActions',
  'navigationTimeoutMs',
  'defaultActionTimeoutMs',
  'headless',
] as const satisfies readonly (keyof AgentSettingsOverride)[];

export class AgentSettingsStore {
  private readonly filePath: string;

  constructor() {
    // Ayrı bir env değişkeni İSTEMEDEN (kurulumu karmaşıklaştırmamak için) — zaten var olan
    // RUNS_DIR'i (test-runs-index.json ile AYNI klasör) genel bir "uygulama verisi" klasörü
    // olarak kullanıyoruz.
    this.filePath = path.join(path.resolve(env.RUNS_DIR), 'agent-settings.json');
  }

  /** Kayıtlı override'ı döner — hiç kaydedilmemişse (dosya yoksa) boş obje döner. */
  async get(): Promise<AgentSettingsOverride> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return {};
      return pickAllowed(parsed as Record<string, unknown>);
    } catch (err) {
      if (isNotFound(err)) return {};
      log.warn({ err }, 'agent-settings.json okunamadı, .env varsayılanlarına düşülüyor');
      return {};
    }
  }

  /** Verilen override'ı OLDUĞU GİBİ (birleştirme YAPMADAN) diske yazar — çağıran taraf (settings.ts
   * route) mevcut override ile birleştirmeyi kendisi yapar. */
  async save(override: AgentSettingsOverride): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(override, null, 2), 'utf-8');
  }
}

function pickAllowed(input: Record<string, unknown>): AgentSettingsOverride {
  const result: AgentSettingsOverride = {};
  for (const key of ALLOWED_KEYS) {
    const value = input[key];
    if (key === 'headless') {
      if (typeof value === 'boolean') result.headless = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      (result as Record<string, number>)[key] = value;
    }
  }
  return result;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'ENOENT';
}

// v3.5 — defaultRunOptions'ın .env'den GELEN HAM değerlerinin bir SNAPSHOT'ı — bu obje bir DAHA
// ASLA mutate edilmez, sadece "Reset to .env Defaults" özelliği için bir referans noktası olarak
// tutulur. Modül yüklenirken (herhangi bir override UYGULANMADAN ÖNCE) alınır, bu yüzden her
// zaman gerçek .env değerlerini yansıtır.
const envRunOptionDefaults: Required<AgentSettingsOverride> = {
  maxSteps: defaultRunOptions.maxSteps,
  minConfidence: defaultRunOptions.minConfidence,
  stepTimeoutMs: defaultRunOptions.stepTimeoutMs,
  maxElementsPerStep: defaultRunOptions.maxElementsPerStep,
  maxRepeatedActions: defaultRunOptions.maxRepeatedActions,
  navigationTimeoutMs: defaultRunOptions.navigationTimeoutMs,
  defaultActionTimeoutMs: defaultRunOptions.defaultActionTimeoutMs,
  headless: defaultRunOptions.headless,
};

/**
 * defaultRunOptions'ı (config/env.ts) VERİLEN override ile YERİNDE (mutate ederek) günceller.
 * BİLİNÇLİ OLARAK defaultRunOptions'ı YENİDEN OLUŞTURMAK yerine mutasyon tercih edildi: bu obje
 * uygulama genelinde onlarca yerde `{ ...defaultRunOptions, ... }` şeklinde spread edilerek
 * kullanılıyor (bkz. ScenarioSuggester/LegacyTestService/runManager) — obje AYNI REFERANSTA
 * kalırsa, bu çağrı yerlerinin HİÇBİRİNİ değiştirmeye gerek kalmadan, bir sonraki İSTEKTEN
 * itibaren (sunucu yeniden başlatılmadan) güncel değerleri görmeleri otomatik sağlanır.
 * `override`'da OLMAYAN (undefined) alanlara hiç dokunulmaz — kısmi bir güncelleme güvenle
 * yapılabilir.
 */
export function applyAgentSettingsOverride(override: AgentSettingsOverride): void {
  if (override.maxSteps !== undefined) defaultRunOptions.maxSteps = override.maxSteps;
  if (override.minConfidence !== undefined) defaultRunOptions.minConfidence = override.minConfidence;
  if (override.stepTimeoutMs !== undefined) defaultRunOptions.stepTimeoutMs = override.stepTimeoutMs;
  if (override.maxElementsPerStep !== undefined) defaultRunOptions.maxElementsPerStep = override.maxElementsPerStep;
  if (override.maxRepeatedActions !== undefined) defaultRunOptions.maxRepeatedActions = override.maxRepeatedActions;
  if (override.navigationTimeoutMs !== undefined) defaultRunOptions.navigationTimeoutMs = override.navigationTimeoutMs;
  if (override.defaultActionTimeoutMs !== undefined) {
    defaultRunOptions.defaultActionTimeoutMs = override.defaultActionTimeoutMs;
  }
  if (override.headless !== undefined) defaultRunOptions.headless = override.headless;
}

/** "Reset to .env Defaults" — defaultRunOptions'ı .env'den okunan ORİJİNAL değerlere geri döndürür. */
export function resetAgentSettingsOverride(): void {
  applyAgentSettingsOverride(envRunOptionDefaults);
}
