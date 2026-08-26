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

    let response: Response;
    try {
      response = await fetch(this.endpoint(), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(
          `Ollama (${this.baseUrl}) ${this.timeoutMs}ms içinde yanıt vermedi. Ollama çalışıyor mu ` +
            "kontrol edin ('ollama serve'). Süre yetersiz geliyorsa .env'de " +
            'VECTOR_CACHE_EMBED_TIMEOUT_MS değerini artırabilirsiniz.',
        );
      }
      throw new Error(
        `Ollama'ya (${this.baseUrl}) bağlanılamadı: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text2 = await response.text().catch(() => '');
      // En sık karşılaşılan durum: model hiç indirilmemiş (404 "model not found"). Kullanıcıya
      // hangi komutu çalıştırması gerektiğini AÇIKÇA söylüyoruz — bkz. env.ts OLLAMA_EMBEDDING_MODEL
      // dosya başı açıklaması (bilinçli olarak sabit bir varsayılan yok).
      throw new Error(
        `Ollama embedding isteği başarısız (HTTP ${response.status}). Model "${this.model}" indirilmiş mi? ` +
          `('ollama pull ${this.model}' ile indirebilirsiniz) ${truncate(text2, 300)}`,
      );
    }

    const json = (await response.json().catch(() => null)) as OllamaEmbeddingResponse | null;
    const vector = json?.embedding;

    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error('Ollama beklenmeyen bir yanıt döndürdü (embedding alanı boş/eksik).');
    }

    return vector;
  }

  private endpoint(): string {
    return `${this.baseUrl.replace(/\/+$/, '')}/api/embeddings`;
  }
}

interface OllamaEmbeddingResponse {
  embedding?: number[];
}

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}
