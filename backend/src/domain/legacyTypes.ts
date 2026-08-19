import type { BrowserEngine, ReplayStep } from './types.js';

/**
 * Bu dosya, mevcut (korunan) frontend'in beklediği eski API sözleşmesine ait tipleri içerir.
 * Bunlar platformun kendi generic modelinden (types.ts) BİLEREK ayrı tutulmuştur: burası bir
 * uyum (adapter) katmanının sözleşmesidir, çekirdek mimarinin bir parçası değildir.
 */

export type LegacyStatus = 'passed' | 'failed';

/** Frontend'in "Generate & Run" / "Run existing test" çağrılarından beklediği yanıt şekli. */
export interface LegacyTestResultResponse {
  generatedCode: string;
  testFile: string;
  status: LegacyStatus;
  message: string;
  result: {
    output: string;
    errorOutput: string;
    exitCode: number;
    artifacts: {
      screenshot?: string;
      video?: string;
      trace?: string;
    };
  };
}

/** GET /api/test-runs listesindeki tek bir kayıt. */
export interface LegacyRunRecord {
  id: string;
  testFile: string;
  status: LegacyStatus;
  browser: BrowserEngine;
  duration: number;
  createdAt: string;
  message?: string;
  error?: string;
  errorOutput?: string;
  exitCode: number;
}

/** GET /api/generated-tests listesindeki + index.json'da saklanan tek bir kayıt. */
export interface LegacyGeneratedTestMeta {
  fileName: string;
  createdAt: string;
  url: string;
  scenario: string;
  variables: Record<string, string>;
  browser: BrowserEngine;
  headed: boolean;
  screenshot: boolean;
  video: boolean;
  trace: boolean;
  /**
   * SADECE bu testi üreten run PASSED ile bittiyse doldurulur — "Replay (No AI)" ile bu testin
   * LLM'e hiç danışılmadan tekrar oynatılabilmesini sağlar (bkz. ReplayStep, AgentLoop.replaySteps).
   * Secret DEĞERİ İÇERMEZ (bkz. ReplayStep dosya başı açıklaması) — diske yazılması güvenlidir.
   */
  replaySteps?: ReplayStep[];
}

export interface LegacyGenerateAndRunInput {
  url: string;
  scenario: string;
  headed: boolean;
  browser: BrowserEngine;
  screenshot: boolean;
  video: boolean;
  trace: boolean;
  variables: Record<string, string>;
  /**
   * Hassas değerler (şifre, token vb.). `variables`'tan BİLEREK ayrı tutulur: AgentLoop/SecretsVault
   * bunları LLM'e/loglara asla düz metin göndermez (bkz. SecretsVault dosya başı açıklaması).
   * ÖNEMLİ: bu alan BİLEREK `LegacyGeneratedTestMeta`'ya (diske kaydedilen index.json) dahil
   * EDİLMEZ — secret değerleri hiçbir zaman diske yazılmaz; bir "generated test"i secrets ile
   * tekrar çalıştırmak isteyen kullanıcı bunları her seferinde yeniden girmelidir.
   */
  secrets?: Record<string, string>;
}

export interface LegacyRunExistingOverrides {
  headed?: boolean;
  browser?: BrowserEngine;
  screenshot?: boolean;
  video?: boolean;
  trace?: boolean;
}
