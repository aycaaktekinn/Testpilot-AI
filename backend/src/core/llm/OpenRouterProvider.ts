import type { LlmCallOptions, LlmMessage, LlmProvider } from './LlmProvider.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('OpenRouterProvider');

interface OpenRouterChoice {
  message?: { content?: string; reasoning?: string; reasoning_content?: string };
  finish_reason?: string;
  native_finish_reason?: string;
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  error?: { message?: string };
}

const DEFAULT_MAX_TOKENS = 1024;

/**
 * OpenRouter (https://openrouter.ai) üzerinden, OpenAI-uyumlu chat completions API'sini kullanır.
 * Varsayılan model ücretsiz (":free" uzantılı) bir model olacak şekilde yapılandırılmıştır.
 */
export class OpenRouterProvider implements LlmProvider {
  readonly name = 'openrouter';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor() {
    if (!env.OPENROUTER_API_KEY) {
      // env.ts zaten LLM_PROVIDER="openrouter" iken bunu zorunlu kılıyor; bu sadece ek bir güvenlik ağı.
      throw new Error('OPENROUTER_API_KEY tanımlı değil');
    }
    this.apiKey = env.OPENROUTER_API_KEY;
    this.baseUrl = env.OPENROUTER_BASE_URL;
    this.model = env.OPENROUTER_MODEL;
  }

  async complete(messages: LlmMessage[], options: LlmCallOptions = {}): Promise<string> {
    const started = Date.now();
    const requestedMaxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

    let data = await this.request(messages, options, requestedMaxTokens);
    let choice = data.choices?.[0];
    let content = choice?.message?.content;
    const reasoning = choice?.message?.reasoning ?? choice?.message?.reasoning_content;
    let finishReason = choice?.finish_reason ?? choice?.native_finish_reason;

    // finish_reason === 'length': model, VERİLEN max_tokens bütçesi bitmeden yanıtı TAMAMLAYAMADAN
    // kesildi. Bu İKİ farklı şekilde ortaya çıkabilir: (a) "reasoning" modelleri tüm bütçeyi
    // görünmez "iç düşünce" metnine harcayıp content'i TAMAMEN boş bırakabilir, (b) normal bir
    // model content ÜRETMEYE başlamış ama yarıda (ör. bir JSON dizisinin ortasında — tam olarak
    // ScenarioSuggester'da canlı gözlemlenen "Unterminated string in JSON" hatasına yol açan durum)
    // kesilmiş olabilir; bu durumda content BOŞ DEĞİLDİR ama kullanılamaz haldedir. ESKİDEN SADECE
    // (a) durumu ele alınıyordu (content boşsa VE reasoning doluysa retry) — (b) durumunda content
    // dolu olduğu için `if (content) return content` hiç finish_reason'a bakmadan DOĞRUDAN
    // döndürüyordu, çağıranı (ör. ScenarioSuggester) kesik/bozuk JSON'u ayrıştırmaya çalışıp
    // başarısız olmaya mahkûm ediyordu. Şimdi HER İKİ durumda da AYNI çözümü uyguluyoruz: aynı
    // isteği daha yüksek bir max_tokens ile bir kez daha dene. Bkz. README > Sorun giderme.
    // v3.12 — bkz. sohbet notu: "yükseltelim onda token olayı zaten yokmuş". Üst sınır 4000'den
    // 8000'e çıkarıldı — kullanılan ücretsiz model başına para derdi yok, tek gerçek kısıt
    // sağlayıcının zaman aşımı (bkz. aşağıdaki timeoutMs), o da artık çağıran (ör.
    // BddDescriptionGenerator) tarafından per-call olarak uzatılabiliyor.
    // v3.14 — bkz. sohbet notu: vitwebpreprodauto canlı log analizi. Bu tavan artık `options.
    // maxTokensRetryCeiling` ile ÇAĞRIYA ÖZEL geçersiz kılınabiliyor (bkz. LlmProvider.ts) — agent'ın
    // canlı adım kararları varsayılan (8000) tavanda kalırken, BddDescriptionGenerator gibi arka
    // planda çalışan çağrılar çok daha yüksek bir tavan isteyebiliyor.
    // v3.17 — bkz. env.ts OPENROUTER_MAX_OUTPUT_TOKENS dosya başı NOT'u (VakıfBank'ın gerçek Qwen3.5
    // dağıtımının doğrulanmış azami çıktısı — 65536). Çağıranın istediği tavan NE OLURSA OLSUN bunun
    // ÜZERİNE çıkılmaz — modelin desteklemediği bir max_tokens istemek sadece sağlayıcıdan hata
    // almaya yol açardı.
    const RETRY_MAX_TOKENS_CEILING = Math.min(
      options.maxTokensRetryCeiling ?? 8000,
      env.OPENROUTER_MAX_OUTPUT_TOKENS,
    );
    if (finishReason === 'length' && requestedMaxTokens < RETRY_MAX_TOKENS_CEILING) {
      // v3.17 — bkz. sohbet notu: canlı logda, x3 çarpanla bile ARA bir bütçeye (ör. 16000)
      // sıçramanın yetmediği, modelin "reasoning"in TAMAMINI yine o ara bütçeye harcayıp içerik
      // ÜRETEMEDİĞİ gözlemlendi. Sadece TEK bir yeniden deneme hakkımız olduğu için (aşağıda ikinci
      // bir bumpedMaxTokens denemesi YOK) artık x3 yerine DOĞRUDAN tavana sıçrıyoruz — elimizdeki
      // TEK şansı en geniş bütçeyle kullanmak, onu israf edip yine yetersiz kalma riskinden HER ZAMAN
      // daha iyidir.
      const bumpedMaxTokens = RETRY_MAX_TOKENS_CEILING;
      log.warn(
        {
          model: this.model,
          requestedMaxTokens,
          bumpedMaxTokens,
          hadReasoning: Boolean(reasoning),
          contentWasTruncated: Boolean(content),
        },
        'Yanıt token bütçesi yetersiz kaldı (finish_reason=length); daha yüksek max_tokens ile tekrar deneniyor',
      );
      const retryData = await this.request(messages, options, bumpedMaxTokens);
      const retryContent = retryData.choices?.[0]?.message?.content;
      if (retryContent) {
        log.debug({ durationMs: Date.now() - started, model: this.model }, 'LLM çağrısı (bütçe artırılarak) tamamlandı');
        return retryContent;
      }
      // v3.14 — HATA DÜZELTMESİ: yeniden deneme de içerik üretemediğinde, aşağıdaki `content`/
      // `data` ESKİDEN hâlâ İLK (düşük bütçeli) isteğin yanıtını gösteriyordu — yani hem "içerik var
      // mı" kontrolü hem de teşhis için loglanan `rawResponse`, aslında artırılmış bütçeyle yapılan
      // DENEMEYİ değil, ondan ÖNCEKİ (zaten başarısız olduğu bilinen) yanıtı yansıtıyordu. Canlı
      // logda "bumpedMaxTokens: 8000" uyarısından hemen sonra gelen ERROR'ın rawResponse.usage.
      // completion_tokens'ının hâlâ 3000 (ilk bütçe) görünmesinin sebebi tam olarak buydu. Şimdi
      // `data`/`choice`/`content`/`finishReason`'ı retryData ile GÜNCELLİYORUZ ki hem aşağıdaki
      // kontrol hem de hata logu gerçekten SON denenen (artırılmış bütçeli) yanıtı yansıtsın.
      data = retryData;
      choice = retryData.choices?.[0];
      content = choice?.message?.content;
      finishReason = choice?.finish_reason ?? choice?.native_finish_reason;
    }

    if (content) {
      // Yeniden deneme hiç tetiklenmediyse (finish_reason 'length' değildi) YA DA tetiklendi ama
      // yine sonuç alınamadıysa (retryContent boş kaldıysa): elimizdeki (muhtemelen hâlâ kesik)
      // içeriği boş dönmektense yine de döndürüyoruz — çağıranın (ör. ScenarioSuggester'ın kendi
      // ayrıştırma/yeniden deneme mantığının) bir şansı olsun diye.
      log.debug({ durationMs: Date.now() - started, model: this.model }, 'LLM çağrısı tamamlandı');
      return content;
    }

    // Teşhis için tüm ham yanıtı logla (secret/kullanıcı verisi İÇERMEZ — yalnızca modelin
    // ürettiği metin). Bir yeniden deneme yapıldıysa bu artık SON (artırılmış bütçeli) denemenin
    // yanıtıdır (bkz. yukarıdaki v3.14 notu) — böylece bir sonraki oluşumda backend loglarından
    // gerçek kök neden (ör. 8000 tokenin TAMAMININ yine reasoning'e gitmesi) doğru görülebilir.
    log.error({ model: this.model, finishReason, rawResponse: data }, 'OpenRouter yanıtında içerik bulunamadı');
    const hint =
      finishReason === 'length'
        ? ' (model token bütçesini "reasoning" için tüketmiş olabilir; farklı bir ücretsiz model deneyin ya da OPENROUTER_DISABLE_REASONING=true deneyin)'
        : ' (openrouter.ai/activity üzerinden bu isteğin ham kaydını inceleyebilirsiniz)';
    throw new Error(`OpenRouter yanıtında içerik bulunamadı${hint}`);
  }

  private async request(
    messages: LlmMessage[],
    options: LlmCallOptions,
    maxTokens: number,
  ): Promise<OpenRouterResponse> {
    // ÖNEMLİ: çıplak fetch() süresiz bekleyebilir — OpenRouter'ın ücretsiz modelleri yoğun
    // saatlerde kuyruğa alınıp çok yavaş (hatta hiç) yanıt verebiliyor. AbortController olmadan
    // bu istek asla zaman aşımına uğramaz ve tüm run (dolayısıyla frontend'deki istek) süresiz
    // "takılı" görünür. Bu yüzden burada açıkça bir zaman sınırı uyguluyoruz.
    const controller = new AbortController();
    // v3.12 — bkz. LlmCallOptions.timeoutMs dosya başı NOT'u: çağıran özel bir süre VERMEDİYSE
    // sağlayıcının genel/varsayılan zaman aşımı (agent'ın canlı adım kararları için kısa tutulmuş)
    // kullanılmaya devam eder — davranış AYNEN eskisi gibi kalır.
    const timeoutMs = options.timeoutMs ?? env.AGENT_LLM_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...(env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': env.OPENROUTER_SITE_URL } : {}),
          ...(env.OPENROUTER_APP_NAME ? { 'X-Title': env.OPENROUTER_APP_NAME } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: options.temperature ?? 0.1,
          max_tokens: maxTokens,
          // NOT: response_format:"json_object" bilerek GÖNDERİLMİYOR. OpenRouter'daki ücretsiz
          // modellerin bir kısmı bu parametreyi desteklemiyor ve isteği tamamen reddedebiliyor.
          // Bunun yerine JSON çıktısı, sistem prompt'undaki talimat + ResponseParser'daki
          // (kod bloğu ayıklama + zod doğrulama + otomatik yeniden deneme) katmanlarıyla sağlanıyor.
          //
          // v3.14 — bkz. env.OPENROUTER_DISABLE_REASONING dosya başı NOT'u: vitwebpreprodauto canlı
          // logunda görülen system_fingerprint ("vllm-0.25.1-...") bu ağ geçidinin vLLM ile sunulan
          // bir Qwen3(.5) modeli olduğunu doğruluyor — bu model ailesi "hibrit thinking" modundadır
          // ve vLLM'in OpenAI-uyumlu sunucusu, `chat_template_kwargs` alanını olduğu gibi sohbet
          // şablonuna geçirir; Qwen3'ün şablonu da `enable_thinking` bayrağını tanır. VARSAYILAN
          // KAPALI olduğundan bu alan yalnızca .env'de açıkça istenirse eklenir — bunu tanımayan bir
          // sunucu (ör. openrouter.ai'nin gerçek halka açık servisi) fazladan/bilinmeyen bir JSON
          // alanını sessizce yok sayar (OpenAI-uyumlu sunucuların standart davranışı), bu yüzden
          // yanlışlıkla açık bırakılsa bile diğer sağlayıcılarda zarar vermesi beklenmez.
          ...(env.OPENROUTER_DISABLE_REASONING
            ? { chat_template_kwargs: { enable_thinking: false } }
            : {}),
        }),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        log.error({ timeoutMs, model: this.model }, 'OpenRouter isteği zaman aşımına uğradı');
        throw new Error(
          `OpenRouter isteği ${timeoutMs}ms içinde yanıt vermedi (ücretsiz model şu anda yavaş/meşgul olabilir). Adım yeniden denenecek.`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      log.error({ status: response.status, text }, 'OpenRouter isteği başarısız');
      throw new Error(`OpenRouter API hatası (${response.status}): ${text.slice(0, 300)}`);
    }

    const data = (await response.json()) as OpenRouterResponse;
    if (data.error) {
      throw new Error(`OpenRouter API hatası: ${data.error.message ?? 'bilinmeyen hata'}`);
    }
    return data;
  }
}
