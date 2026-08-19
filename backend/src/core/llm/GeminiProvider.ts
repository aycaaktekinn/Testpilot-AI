import type { LlmCallOptions, LlmMessage, LlmProvider } from './LlmProvider.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../config/logger.js';
import { LlmConfigurationError } from '../../domain/errors.js';

const log = createLogger('GeminiProvider');

const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

interface GeminiPart {
  text?: string;
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[]; role?: string };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string; code?: number };
}

/**
 * Google Gemini API (https://ai.google.dev) — OpenRouter'a alternatif, doğrudan Google'ın
 * kendi barındırdığı ücretsiz katman. OpenRouter'daki topluluk ":free" modellerinin aksine
 * Google'ın kendi altyapısında çalıştığı için genelde daha kararlı/hızlı yanıt verir.
 *
 * API sözleşimi OpenAI/OpenRouter'dan farklıdır: mesajlar "contents" (role: user/model) +
 * ayrı bir "systemInstruction" alanı olarak gönderilir; yanıt "candidates[0].content.parts[].text"
 * altında döner. Bu farkları burada, dışa (LlmProvider arayüzüne) sızdırmadan yönetiyoruz.
 *
 * NOT: API anahtarı ve model adı SADECE `env` (dolayısıyla `process.env.GEMINI_API_KEY` /
 * `process.env.GEMINI_MODEL`) üzerinden okunur; bu sınıf dışında Gemini'ye ait tek bir HTTP
 * çağrısı yapılmaz — tüm istek/yanıt mantığı burada, TEK yerde toplanmıştır.
 */
export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor() {
    // env.ts zaten LLM_PROVIDER="gemini" iken bu ikisini zorunlu kılıyor (.superRefine);
    // bu kontroller sadece ek bir güvenlik ağıdır (ve TypeScript'e `string` tipini garanti eder).
    if (!env.GEMINI_API_KEY) {
      throw new LlmConfigurationError('GEMINI_API_KEY tanımlı değil.');
    }
    if (!env.GEMINI_MODEL) {
      throw new LlmConfigurationError(
        'GEMINI_MODEL tanımlı değil. .env dosyanıza GEMINI_MODEL=<model-adı> ekleyin ' +
          '(güncel/kullanılabilir model adını https://aistudio.google.com/ üzerinden doğrulayın).',
      );
    }
    this.apiKey = env.GEMINI_API_KEY;
    this.baseUrl = env.GEMINI_BASE_URL;
    this.model = env.GEMINI_MODEL;
  }

  /**
   * Ön-kontrol: `GEMINI_MODEL`'in bu API anahtarı/hesap için GERÇEKTEN çağrılabilir olduğunu,
   * minimal (1 token) gerçek bir generateContent isteğiyle doğrular. AgentLoop bunu, Playwright/
   * tarayıcıyı hiç başlatmadan ÖNCE çağırır.
   *
   * ÖNEMLİ: ListModels/tekil model-bilgisi uç noktası TEK BAŞINA yeterli değildir — bir model o
   * katalog uç noktalarında "var" ve "generateContent destekliyor" görünse bile, gerçek bir
   * generateContent isteğinde YİNE DE 404 ("... is no longer available to new users") dönebiliyor;
   * tam olarak yaşanan sorun buydu. Bu yüzden burada `request()` (complete()'in kullandığı AYNI
   * gerçek istek yolu) tekrar kullanılıyor — Gemini'ye ait TÜM HTTP mantığı hâlâ tek yerde.
   */
  async validateConfig(): Promise<void> {
    try {
      await this.request([{ role: 'user', content: 'ping' }], {}, 1);
    } catch (err) {
      if (err instanceof LlmConfigurationError) {
        // KESİN bir yapılandırma hatası (örn. 404 model_not_found) — yukarı fırlat, AgentLoop
        // tarayıcıyı hiç başlatmadan run'ı anında sonlandırsın.
        throw err;
      }
      // Diğer (ağ/zaman aşımı/geçici sunucu) hataları burada YOK SAYILIR: validateConfig'in görevi
      // sadece KESİN yapılandırma hatalarını erkenden yakalamaktır — geçici sorunlar için normal
      // akıştaki (AgentLoop'un adım döngüsündeki) retry/timeout mekanizmaları zaten devrededir.
      log.warn(
        { err, model: this.model },
        'Gemini ön-kontrol isteği başarısız oldu ama kesin bir yapılandırma hatası değil; run normal şekilde devam edecek',
      );
    }
  }

  async complete(messages: LlmMessage[], options: LlmCallOptions = {}): Promise<string> {
    const started = Date.now();
    const requestedMaxTokens = options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

    const data = await this.request(messages, options, requestedMaxTokens);
    const candidate = data.candidates?.[0];
    const text = extractText(candidate);
    const finishReason = candidate?.finishReason;

    if (data.promptFeedback?.blockReason) {
      throw new Error(`Gemini isteği güvenlik filtresine takıldı: ${data.promptFeedback.blockReason}`);
    }

    // OpenRouterProvider'daki AYNI genelleştirilmiş korumanın eşleniği: finishReason="MAX_TOKENS"
    // hem text'in TAMAMEN boş kalması (ör. "thinking" özelliği açık modellerin bütçeyi iç düşünce
    // sürecine harcaması) hem de text'in DOLU ama yarıda (ör. bir JSON dizisinin ortasında) kesilmiş
    // olması anlamına gelebilir. ESKİDEN SADECE text boşken kontrol ediliyordu — text doluysa
    // `if (text) return text` finishReason'a hiç bakmadan DOĞRUDAN döndürüyordu, çağıranı kesik/
    // bozuk JSON'u ayrıştırmaya çalışıp başarısız olmaya mahkûm ediyordu. Şimdi HER İKİ durumda da
    // AYNI isteği daha yüksek bir bütçeyle bir kez daha deniyoruz.
    if (finishReason === 'MAX_TOKENS' && requestedMaxTokens < 4000) {
      const bumpedMaxTokens = Math.min(requestedMaxTokens * 3, 4000);
      log.warn(
        { model: this.model, requestedMaxTokens, bumpedMaxTokens, textWasTruncated: Boolean(text) },
        'Yanıt token bütçesi yetersiz kaldı (finishReason=MAX_TOKENS); daha yüksek bütçeyle tekrar deneniyor',
      );
      const retryData = await this.request(messages, options, bumpedMaxTokens);
      const retryText = extractText(retryData.candidates?.[0]);
      if (retryText) {
        log.debug({ durationMs: Date.now() - started, model: this.model }, 'LLM çağrısı (bütçe artırılarak) tamamlandı');
        return retryText;
      }
    }

    if (text) {
      // Yeniden deneme hiç tetiklenmediyse YA DA tetiklendi ama yine sonuç alınamadıysa: elimizdeki
      // (muhtemelen hâlâ kesik) metni boş dönmektense yine de döndürüyoruz — çağıranın kendi
      // ayrıştırma/yeniden deneme mantığına bir şans tanımak için.
      log.debug({ durationMs: Date.now() - started, model: this.model }, 'LLM çağrısı tamamlandı');
      return text;
    }

    log.error({ model: this.model, finishReason, rawResponse: data }, 'Gemini yanıtında içerik bulunamadı');
    throw new Error(
      `Gemini yanıtında içerik bulunamadı (finishReason=${finishReason ?? 'bilinmiyor'}). ` +
        'GEMINI_MODEL değerini https://aistudio.google.com/ üzerinden doğrulayın.',
    );
  }

  private async request(
    messages: LlmMessage[],
    options: LlmCallOptions,
    maxOutputTokens: number,
  ): Promise<GeminiResponse> {
    const systemInstruction = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const controller = new AbortController();
    const timeoutMs = env.AGENT_LLM_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent?key=${this.apiKey}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
          generationConfig: {
            temperature: options.temperature ?? 0.1,
            maxOutputTokens,
          },
        }),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        log.error({ timeoutMs, model: this.model }, 'Gemini isteği zaman aşımına uğradı');
        throw new Error(`Gemini isteği ${timeoutMs}ms içinde yanıt vermedi. Adım yeniden denenecek.`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404) {
      // Model artık mevcut değil / kullanılamıyor: bu RETRY EDİLEMEZ bir yapılandırma hatasıdır.
      // normalde validateConfig() bunu daha erken (tarayıcı başlamadan) yakalar; bu, aynı sınıf
      // hatanın run SIRASINDA (örn. model run başladıktan sonra kullanımdan kaldırılırsa) da
      // doğru şekilde ele alınmasını sağlayan bir güvenlik ağıdır.
      const text = await response.text().catch(() => '');
      log.error({ status: response.status, text, model: this.model }, 'Gemini modeli bulunamadı (404)');
      throw new LlmConfigurationError(
        `GEMINI_MODEL="${this.model}" bulunamadı/kullanılamıyor (404): ${text.slice(0, 300)}. ` +
          '.env içindeki GEMINI_MODEL değerini https://aistudio.google.com/ üzerinden doğrulanmış ' +
          'güncel bir modelle değiştirin.',
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      log.error({ status: response.status, text }, 'Gemini isteği başarısız');
      // API anahtarı GÜVENLİK NEDENİYLE hata mesajına dahil edilmez (query string'de gönderiliyor).
      throw new Error(`Gemini API hatası (${response.status}): ${text.slice(0, 300)}`);
    }

    const data = (await response.json()) as GeminiResponse;
    if (data.error) {
      if (data.error.status === 'NOT_FOUND' || data.error.code === 404) {
        throw new LlmConfigurationError(
          `GEMINI_MODEL="${this.model}" bulunamadı/kullanılamıyor: ${data.error.message ?? 'bilinmeyen hata'}`,
        );
      }
      throw new Error(`Gemini API hatası: ${data.error.message ?? 'bilinmeyen hata'}`);
    }
    return data;
  }
}

function extractText(candidate: GeminiCandidate | undefined): string {
  return (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');
}
