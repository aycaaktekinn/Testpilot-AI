export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = 'APP_ERROR') {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}

/** Ajan döngüsü içinde, güvenli şekilde FAIL üretmesi gereken kontrollü hatalar için. */
export class AgentSafetyStopError extends Error {
  public readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'AgentSafetyStopError';
    this.reason = reason;
  }
}

/**
 * LLM sağlayıcısı YANLIŞ YAPILANDIRILMIŞ olduğunda fırlatılır — örn. geçersiz/artık kullanılamayan
 * bir model adı (404 model_not_found) ya da geçersiz API anahtarı. Bu sınıftaki hatalar RETRY
 * EDİLEMEZ: aynı isteği tekrar göndermek aynı sonucu üretir. AgentLoop bu tipi gördüğünde ne LLM
 * çağrısını yeniden dener ne de (henüz başlamadıysa) Playwright/tarayıcıyı hiç başlatır.
 */
export class LlmConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmConfigurationError';
  }
}

/**
 * v2.0 — Selenium Grid hub'ıyla ilgili bir sorun olduğunda fırlatılır: hub yapılandırılmamış
 * (SELENIUM_GRID_URL boş), hub'a ulaşılamıyor, desteklenmeyen bir tarayıcı motoruyla (Firefox/
 * WebKit) Grid istenmiş, ya da hub session açmayı reddetti/CDP adresi dönmedi. LlmConfigurationError
 * ile aynı desen: bu bir SİTE/SENARYO hatası DEĞİL, bir ALTYAPI/YAPILANDIRMA hatasıdır — bkz.
 * AgentLoop.run()'daki 'grid_error:' önekli işleme.
 */
export class SeleniumGridError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeleniumGridError';
  }
}
