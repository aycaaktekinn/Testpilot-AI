export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCallOptions {
  temperature?: number;
  maxTokens?: number;
}

/**
 * Provider-agnostic LLM arayüzü. Yeni bir sağlayıcı eklemek için bu arayüzü
 * implemente eden yeni bir sınıf yazmak yeterlidir (örn. OpenAiProvider, AnthropicProvider).
 */
export interface LlmProvider {
  readonly name: string;
  /** Ham metin tamamlama; JSON parse etme sorumluluğu çağırana aittir. */
  complete(messages: LlmMessage[], options?: LlmCallOptions): Promise<string>;
  /**
   * Opsiyonel ön-kontrol: API anahtarının geçerli olduğunu ve yapılandırılan modelin bu hesap/
   * endpoint için gerçekten kullanılabilir olduğunu, herhangi bir "gerçek" tamamlama isteği
   * göndermeden doğrular. Başarısızsa `LlmConfigurationError` fırlatmalıdır. AgentLoop bunu,
   * Playwright/tarayıcıyı hiç başlatmadan ÖNCE çağırır — böylece geçersiz bir model yüzünden
   * gereksiz yere gerçek bir tarayıcı oturumu açılmaz.
   */
  validateConfig?(): Promise<void>;
}
