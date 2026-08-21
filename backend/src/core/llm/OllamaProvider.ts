import type { LlmCallOptions, LlmMessage, LlmProvider } from './LlmProvider.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../config/logger.js';
import { LlmConfigurationError } from '../../domain/errors.js';

const log = createLogger('OllamaProvider');

const DEFAULT_NUM_PREDICT = 1024;

interface OllamaChatMessage {
  role?: string;
  content?: string;
}

interface OllamaChatResponse {
  message?: OllamaChatMessage;
  done?: boolean;
  done_reason?: string;
  error?: string;
}

/**
 * v2.3 — Ollama (https://ollama.com), kullanıcının KENDİ makinesinde (ör. `ollama serve`) yerelde
 * çalışan bir model sunucusu — OpenRouter/Gemini'nin AKSİNE bulutta değil, tamamen offline/ücretsiz
 * çalışır, API anahtarı GEREKMEZ. Proje bu NOKTAYA kadar Ollama'yı SADECE vector cache'in embedding
 * tarafında (bkz. EmbeddingClient) kullanıyordu; bu sınıf Ollama'yı asıl KARAR VERİCİ AI (LLM_PROVIDER)
 * olarak da kullanılabilir hale getirir — `OLLAMA_URL` (zaten var olan, embedding tarafıyla PAYLAŞILAN
 * değişken) ile aynı sunucuya, ama AYRI bir modelle (`OLLAMA_MODEL` — embedding modelinden farklı,
 * bir "chat/instruct" modeli olmalıdır, ör. `ollama pull llama3.1` veya `qwen2.5:7b-instruct`) konuşur.
 *
 * API sözleşmesi diğer sağlayıcılardan farklıdır: OpenAI/OpenRouter'a YAKIN ama kendi native
 * `/api/chat` uç noktasını kullanır (OpenAI-uyumluluk katmanı yerine — daha az dolaylama, daha az
 * hata yüzeyi). Yanıt "message.content" altında düz metin olarak döner; JSON çıktısı (diğer
 * sağlayıcılarla AYNI şekilde) sistem prompt talimatı + ResponseParser'daki kod bloğu ayıklama/zod
 * doğrulama katmanlarıyla sağlanır — burada `format:"json"` BİLİNÇLİ OLARAK gönderilmiyor, çünkü
 * yerel/küçük modellerin bir kısmı bu parametreyle ya desteklemiyor ya da beklenmedik şekilde
 * davranıyor (OpenRouterProvider'daki AYNI gerekçe).
 */
export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';

  private readonly baseUrl: string;
  private readonly model: string;

  constructor() {
    // env.ts zaten LLM_PROVIDER="ollama" iken OLLAMA_MODEL'i zorunlu kılıyor (.superRefine);
    // bu kontrol sadece ek bir güvenlik ağıdır (ve TypeScript'e `string` tipini garanti eder).
    if (!env.OLLAMA_MODEL) {
      throw new LlmConfigurationError(
        'OLLAMA_MODEL tanımlı değil. .env dosyanıza OLLAMA_MODEL=<model-adı> ekleyin ' +
          '(önce `ollama pull <model-adı>` ile indirmeniz gerekir — ör. `ollama pull llama3.1`).',
      );
    }
    this.baseUrl = env.OLLAMA_URL.replace(/\/+$/, '');
    this.model = env.OLLAMA_MODEL;
  }

  /**
   * Ön-kontrol: modelin GERÇEKTEN yerel Ollama sunucusunda mevcut/çağrılabilir olduğunu, minimal
   * (num_predict:1) gerçek bir /api/chat isteğiyle doğrular — GeminiProvider.validateConfig()'teki
   * AYNI prensip (bir "model listesi" uç noktası TEK BAŞINA yeterli değildir, gerçek isteğin kendisi
   * denenmelidir). AgentLoop bunu, Playwright/tarayıcıyı hiç başlatmadan ÖNCE çağırır.
   */
  async validateConfig(): Promise<void> {
    try {
      await this.request([{ role: 'user', content: 'ping' }], {}, 1);
    } catch (err) {
      if (err instanceof LlmConfigurationError) {
        // KESİN bir yapılandırma hatası (model indirilmemiş, sunucuya hiç ulaşılamıyor vb.) —
        // yukarı fırlat, AgentLoop tarayıcıyı hiç başlatmadan run'ı anında sonlandırsın.
        throw err;
      }
      // Diğer (geçici sunucu) hataları burada YOK SAYILIR — normal akıştaki adım-içi retry/timeout
      // mekanizmaları zaten devrededir (GeminiProvider ile AYNI felsefe).
      log.warn(
        { err, model: this.model },
        'Ollama ön-kontrol isteği başarısız oldu ama kesin bir yapılandırma hatası değil; run normal şekilde devam edecek',
      );
    }
  }

  async complete(messages: LlmMessage[], options: LlmCallOptions = {}): Promise<string> {
    const started = Date.now();
    const requestedNumPredict = options.maxTokens ?? DEFAULT_NUM_PREDICT;

    const data = await this.request(messages, options, requestedNumPredict);
    const content = data.message?.content;
    const doneReason = data.done_reason;

    // OpenRouterProvider/GeminiProvider'daki AYNI genelleştirilmiş koruma: done_reason="length"
    // hem content'in TAMAMEN boş kalması hem de DOLU ama yarıda kesilmiş olması anlamına gelebilir.
    // Her iki durumda da AYNI isteği daha yüksek bir num_predict bütçesiyle bir kez daha deniyoruz.
    if (doneReason === 'length' && requestedNumPredict < 4000) {
      const bumpedNumPredict = Math.min(requestedNumPredict * 3, 4000);
      log.warn(
        { model: this.model, requestedNumPredict, bumpedNumPredict, contentWasTruncated: Boolean(content) },
        'Yanıt token bütçesi yetersiz kaldı (done_reason=length); daha yüksek num_predict ile tekrar deneniyor',
      );
      const retryData = await this.request(messages, options, bumpedNumPredict);
      const retryContent = retryData.message?.content;
      if (retryContent) {
        log.debug({ durationMs: Date.now() - started, model: this.model }, 'LLM çağrısı (bütçe artırılarak) tamamlandı');
        return retryContent;
      }
    }

    if (content) {
      log.debug({ durationMs: Date.now() - started, model: this.model }, 'LLM çağrısı tamamlandı');
      return content;
    }

    log.error({ model: this.model, doneReason, rawResponse: data }, 'Ollama yanıtında içerik bulunamadı');
    throw new Error(`Ollama yanıtında içerik bulunamadı (done_reason=${doneReason ?? 'bilinmiyor'}).`);
  }

  private async request(messages: LlmMessage[], options: LlmCallOptions, numPredict: number): Promise<OllamaChatResponse> {
    const controller = new AbortController();
    const timeoutMs = env.AGENT_LLM_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          options: {
            temperature: options.temperature ?? 0.1,
            num_predict: numPredict,
          },
        }),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        log.error({ timeoutMs, model: this.model }, 'Ollama isteği zaman aşımına uğradı');
        throw new Error(`Ollama isteği ${timeoutMs}ms içinde yanıt vermedi. Adım yeniden denenecek.`);
      }
      // v2.3 — Ollama'nın diğer sağlayıcılardan FARKI: bulutta değil, kullanıcının kendi
      // makinesinde çalışır — "bağlantı reddedildi" (ECONNREFUSED) gibi bir ağ hatası, o an
      // `ollama serve` çalışmıyor demektir ve GEÇİCİ bir durum DEĞİLDİR (aksi ispatlanana kadar tüm
      // run boyunca sürer). Bu yüzden BİLİNÇLİ OLARAK burada LlmConfigurationError'a çeviriyoruz —
      // AgentLoop.validateConfig() bunu erken yakalayıp, hiç boşa bir tarayıcı oturumu açmadan
      // run'ı anlaşılır bir hatayla durdurabilsin.
      log.error({ err, baseUrl: this.baseUrl }, "Ollama sunucusuna bağlanılamadı");
      throw new LlmConfigurationError(
        `Ollama sunucusuna (${this.baseUrl}) bağlanılamadı. Yerel makinenizde \`ollama serve\` çalışıyor mu ` +
          `ve OLLAMA_URL doğru mu kontrol edin. (${err instanceof Error ? err.message : String(err)})`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // Ollama, indirilmemiş/bilinmeyen bir model istendiğinde genelde 404 (bazı sürümlerde 400)
      // ile "model '<ad>' not found, try pulling it first" benzeri bir mesaj döner — bu KESİN bir
      // yapılandırma hatasıdır (GeminiProvider'ın 404 model_not_found ele alışıyla AYNI prensip).
      const looksLikeMissingModel = /not found|try pulling/i.test(text);
      if (response.status === 404 || looksLikeMissingModel) {
        log.error({ status: response.status, text, model: this.model }, 'Ollama modeli bulunamadı');
        throw new LlmConfigurationError(
          `OLLAMA_MODEL="${this.model}" bulunamadı/indirilmemiş: ${truncate(text, 300)}. ` +
            `Önce \`ollama pull ${this.model}\` çalıştırın.`,
        );
      }
      log.error({ status: response.status, text }, 'Ollama isteği başarısız');
      throw new Error(`Ollama API hatası (${response.status}): ${truncate(text, 300)}`);
    }

    const data = (await response.json()) as OllamaChatResponse;
    if (data.error) {
      const looksLikeMissingModel = /not found|try pulling/i.test(data.error);
      if (looksLikeMissingModel) {
        throw new LlmConfigurationError(`OLLAMA_MODEL="${this.model}" bulunamadı/indirilmemiş: ${data.error}`);
      }
      throw new Error(`Ollama API hatası: ${data.error}`);
    }
    return data;
  }
}

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}
