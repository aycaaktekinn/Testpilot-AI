export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCallOptions {
  temperature?: number;
  maxTokens?: number;
  /**
   * v3.12 — bkz. sohbet notu: "yükseltelim onda token olayı zaten yokmuş" (kullanılan model
   * ücretsiz, token maliyeti derdi yok). Tek bir çağrının, sağlayıcının varsayılan zaman aşımından
   * (bkz. OpenRouterProvider.request() — env.AGENT_LLM_TIMEOUT_MS, agent'ın canlı adım kararları
   * İÇİN kısa tutulmuş genel bir süre) DAHA UZUN sürmesine izin vermek için — ör.
   * BddDescriptionGenerator gibi, run bittikten SONRA arka planda çalışan, kullanıcıyı canlı
   * beklemede TUTMAYAN best-effort çağrılar, büyük bir max_tokens bütçesiyle (reasoning modelleri
   * için) daha uzun sürebilir; global zaman aşımını (agent'ın kendi adım kararlarını da etkiler)
   * DEĞİŞTİRMEDEN sadece BU çağrıya özel bir üst sınır verir. Belirtilmezse sağlayıcı kendi
   * varsayılanını (env.AGENT_LLM_TIMEOUT_MS) kullanır.
   */
  timeoutMs?: number;
  /**
   * v3.14 — bkz. sohbet notu: vitwebpreprodauto canlı log analizi — Qwen3.5 (vLLM), 8000 tokenlık
   * OpenRouterProvider yeniden deneme tavanına RAĞMEN bütçenin tamamını görünmez "reasoning"e
   * harcayıp içerik üretemedi. OpenRouterProvider'daki MODÜL SEVİYESİNDEKİ RETRY_MAX_TOKENS_CEILING
   * (varsayılan 8000) TÜM çağrı yerlerini (hem agent'ın canlı adım kararlarını HEM
   * BddDescriptionGenerator'ı) etkiler — agent'ın adım kararları interaktif olduğundan bu tavanı
   * herkes için büyütmek riskli (daha uzun, kullanıcıyı bekleten adımlara yol açar). Bu alan, YALNIZCA
   * BU çağrı için o tavanı geçersiz kılar; belirtilmezse sağlayıcı kendi modül-seviyesi varsayılanını
   * kullanır. BddDescriptionGenerator, koşum bittikten SONRA arka planda çalıştığı için bunu güvenle
   * çok daha yükseğe (bkz. dosya başı yorumu) çekebilir.
   */
  maxTokensRetryCeiling?: number;
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
