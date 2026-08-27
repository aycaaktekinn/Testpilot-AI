/**
 * Ollama'nın embedding üretmesi bu süreden uzun sürerse iptal edilir. SADECE bir VARSAYILAN/geri
 * düşüş değeri — gerçek çalışma zamanında `env.VECTOR_CACHE_EMBED_TIMEOUT_MS` (bkz. env.ts) bunu
 * ezer, bkz. VectorCacheStore constructor'ı. Burada tutulmasının tek nedeni, bu sınıfı doğrudan
 * (3. parametre vermeden) oluşturan testlerin/çağrıların kırılmaması.
 *
 * NEDEN eskiden sabit 20sn yetmiyordu: yerel bir embedding modeli (özellikle 4b gibi büyükçe
 * quantize modeller) Ollama'nın belleğine İLK istekte yükleniyor ("cold start") — bu, sınırlı
 * RAM'li makinelerde 20 saniyeyi kolayca aşabiliyor. Model bir kez belleğe yüklendikten sonra
 * sonraki istekler çok daha hızlı oluyor, ama İLK isteğin süresini garanti edemeyiz.
 */
export const DEFAULT_EMBED_TIMEOUT_MS = 20_000;

/**
 * Ollama'nın yerelde çalışan `/api/embeddings` uç noktasıyla konuşan küçük bir istemci — Selenium
 * Grid'deki `SeleniumGridClient` ile AYNI prensip: Ollama'nın kendi HTTP API'si zaten basit ve tek
 * ihtiyacımız (bir metni vektöre çevirmek) çok dar olduğu için ayrı bir SDK paketi KULLANILMIYOR.
 *
 * ÖNEMLİ (v2.0 mimari kararı): embed edilen metin ASLA secret DEĞERİ içermemelidir — bkz.
 * situationText.ts dosya başı açıklaması, oradaki metin sadece sayfa/element YAPISINI (tag/role/
 * accessibleName) ve senaryo metnini içerir, hiçbir zaman girilen gerçek değerleri değil.
 */
export class EmbeddingClient {
  /**
   * v3.1 — SIRAYA ALMA (serialization) kuyruğu: `AgentLoop.recordDecisionInCache` her başarılı adımda
   * bu istemciyi "fire-and-forget" (await edilmeden, bkz. AgentLoop dosya başı NOT) çağırır — yani bir
   * run birkaç adımı hızlıca art arda tamamlarsa, birden fazla embed() çağrısı NEREDEYSE AYNI ANDA
   * Ollama'ya gidebilir. Ollama tek bir modeli genelde TEK SEFERDE (seri) işler — bu yüzden 2., 3., 4.
   * istek kendi HTTP bağlantısı hemen açılmış olsa bile, Ollama'nın İÇİNDE bir öncekinin bitmesini
   * BEKLER. Her isteğin kendi 60sn'lik zaman aşımı saati fetch() çağrıldığı ANDAN başladığı için
   * (bkz. aşağıdaki AbortController), sırada bekleyen bir istek kendi payına düşen işlem süresine hiç
   * ulaşamadan zaman aşımına uğrayabilir — modelin/Ollama'nın kendisi TAMAMEN SAĞLIKLIYKEN bile
   * (canlı gözlem: tek başına çalıştırılan bir curl isteği anında yanıt döndü, ama bir test run'ı
   * sırasında art arda gelen embedding çağrıları 60sn'yi aştı). Çözüm: bu istemci üzerindeki TÜM
   * embed() çağrılarını burada, Node tarafında TEK TEK SIRAYLA çalıştırıyoruz — böylece Ollama'ya
   * asla birden fazla eşzamanlı istek gitmez, ve her isteğin 60sn'lik saati ancak SIRASI GELİP
   * fetch() gerçekten çağrıldığında başlar (kuyrukta beklediği süre bu saate DAHİL DEĞİLDİR).
   */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs: number = DEFAULT_EMBED_TIMEOUT_MS,
    // v3.3 — .env'den (VECTOR_CACHE_EMBED_NUM_THREAD) gelir; bkz. env.ts dosya başı NOT'u. TANIMSIZSA
    // Ollama'ya hiç `options` gönderilmez (kendi varsayılanını kullanır, davranış DEĞİŞMEZ) — bkz.
    // aşağıdaki embedNow().
    private readonly numThread?: number,
  ) {}

  async embed(text: string): Promise<number[]> {
    // Bir önceki (varsa) çağrının bitmesini bekle — başarılı ya da başarısız fark etmez, kuyruk
    // asla bir hatayla tıkanıp kalmamalı (bkz. `.then(noop, noop)` ile hem başarı hem hata yolu
    // aynı şekilde "sıradakine geç" sinyaline çevriliyor).
    const previous = this.queue;
    let release: () => void;
    this.queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.embedNow(text);
    } finally {
      release!();
    }
  }

  private async embedNow(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const openAiStyle = this.isOpenAiStyleEndpoint();

    let response: Response;
    try {
      response = await fetch(this.endpoint(), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          openAiStyle
            ? // OpenAI-uyumlu (ör. vLLM/TGI arkasında, şirket içi bir gateway üzerinden sunulan)
              // embedding servisleri `input` alanı ve `data[].embedding` yanıt şekli kullanır —
              // Ollama'nın kendi `prompt`/`embedding` sözleşmesinden TAMAMEN FARKLI (bkz. aşağıdaki
              // isOpenAiStyleEndpoint() NOT'u). `num_thread` Ollama'ya özgü bir ayar olduğu için bu
              // dalda HİÇ gönderilmez (hedef sunucu bunu tanımaz).
              { model: this.model, input: text }
            : {
                model: this.model,
                prompt: text,
                // v3.3 — bkz. constructor'daki numThread NOT'u: canlı bir run sırasında (CPU contention
                // altında) daha AZ thread istemek paradoksal şekilde DAHA HIZLI tamamlanmayı sağlayabiliyor
                // (canlıda doğrulandı — 72sn'den 6-12sn'ye düştü). TANIMSIZSA options hiç gönderilmez.
                ...(this.numThread ? { options: { num_thread: this.numThread } } : {}),
              },
        ),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          openAiStyle
            ? `Embedding servisi (${this.baseUrl}) ${this.timeoutMs}ms içinde yanıt vermedi. Süre ` +
              "yetersiz geliyorsa .env'de VECTOR_CACHE_EMBED_TIMEOUT_MS değerini artırabilirsiniz."
            : `Ollama (${this.baseUrl}) ${this.timeoutMs}ms içinde yanıt vermedi. Ollama çalışıyor mu ` +
              "kontrol edin ('ollama serve'). Süre yetersiz geliyorsa .env'de " +
              'VECTOR_CACHE_EMBED_TIMEOUT_MS değerini artırabilirsiniz.',
        );
      }
      throw new Error(
        `${openAiStyle ? 'Embedding servisine' : "Ollama'ya"} (${this.baseUrl}) bağlanılamadı: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text2 = await response.text().catch(() => '');
      throw new Error(
        openAiStyle
          ? `Embedding isteği başarısız (HTTP ${response.status}): ${truncate(text2, 300)}`
          : // En sık karşılaşılan durum: model hiç indirilmemiş (404 "model not found"). Kullanıcıya
            // hangi komutu çalıştırması gerektiğini AÇIKÇA söylüyoruz — bkz. env.ts OLLAMA_EMBEDDING_MODEL
            // dosya başı açıklaması (bilinçli olarak sabit bir varsayılan yok).
            `Ollama embedding isteği başarısız (HTTP ${response.status}). Model "${this.model}" indirilmiş mi? ` +
            `('ollama pull ${this.model}' ile indirebilirsiniz) ${truncate(text2, 300)}`,
      );
    }

    const json = await response.json().catch(() => null);
    const vector = openAiStyle
      ? (json as OpenAiEmbeddingResponse | null)?.data?.[0]?.embedding
      : (json as OllamaEmbeddingResponse | null)?.embedding;

    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error(
        `${openAiStyle ? 'Embedding servisi' : 'Ollama'} beklenmeyen bir yanıt döndürdü (embedding alanı boş/eksik).`,
      );
    }

    return vector;
  }

  /**
   * OLLAMA_URL iki tamamen farklı biçimde verilebilir:
   *  1) Ollama'nın kendi varsayılanı gibi SADECE bir host:port (ör. http://localhost:11434) — bu
   *     durumda Ollama'nın native `/api/embeddings` yolunu BİZ ekleriz, istek `prompt` alanı ve
   *     düz `{embedding: [...]}` yanıtı kullanır (Ollama'nın kendi sözleşmesi).
   *  2) Şirket içi bir gateway'in TAM, kullanıma hazır bir OpenAI-uyumlu endpoint'i (ör.
   *     .../v1/embeddings) — VakıfBank'ın iç ağında barındırılan qwen3-embedding-8b gibi servisler
   *     bu şekilde sunuluyor. Bu durumda (a) URL'e HİÇBİR ŞEY EKLEMEYİZ (zaten tam), (b) istek
   *     `input` alanı, yanıt `data[0].embedding` şeklini kullanır — Ollama'nınkinden TAMAMEN FARKLI.
   * Ayrım, baseUrl'in path'inde zaten "embeddings" geçip geçmediğine bakılarak yapılır — bu, mevcut
   * bare-host (varsayılan) kullanıcılar için davranışı HİÇ DEĞİŞTİRMEZ (regresyon riski yok), yeni
   * tam-URL veren kullanıcılar için ise doğru sözleşmeyi otomatik seçer.
   */
  private isOpenAiStyleEndpoint(): boolean {
    return /\/embeddings\b/i.test(this.baseUrl);
  }

  private endpoint(): string {
    if (this.isOpenAiStyleEndpoint()) {
      return this.baseUrl;
    }
    return `${this.baseUrl.replace(/\/+$/, '')}/api/embeddings`;
  }
}

interface OllamaEmbeddingResponse {
  embedding?: number[];
}

interface OpenAiEmbeddingResponse {
  data?: { embedding?: number[] }[];
}

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}
