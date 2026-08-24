import { MilvusClient, DataType } from '@zilliz/milvus2-sdk-node';
import { DEFAULT_EMBED_TIMEOUT_MS, EmbeddingClient } from './EmbeddingClient.js';
import { buildSituationText, safeHostname, type SituationInput } from './situationText.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('VectorCacheStore');

/**
 * Koleksiyon adı sabittir (v2.0'da kullanıcı tarafından yapılandırılabilir DEĞİL) — bu proje TEK
 * bir "locator cache" koleksiyonu kullanır, birden fazla koleksiyon yönetimi bu aşamada gereksiz
 * bir karmaşıklık olurdu.
 */
const COLLECTION_NAME = 'testpilot_locator_cache';

/**
 * Yazma tarafındaki (write-time) TEKRAR ÖNLEME eşiği — bkz. `recordDecision` içindeki
 * `isNearDuplicate` çağrısı. `VECTOR_CACHE_MIN_SIMILARITY`'DEN (okuma/cache-hit eşiği, kullanıcı
 * tarafından .env'de yapılandırılabilir — bkz. env.ts) BİLEREK AYRI ve SABİTTİR: buradaki soru
 * "bu durumu LLM yerine kullanabilir miyim" değil, "bu durum zaten neredeyse birebir aynısıyla
 * kayıtlı mı, tekrar eklemek anlamsız mı" sorusudur — ikisinin yanlış-pozitif/yanlış-negatif
 * toleransı farklı olabileceği için ayrı bir sabit tutulur.
 *
 * 0.998 DEĞERİ CANLI GÖZLEMDEN GELİR: aynı senaryo/adımın tekrarlanan koşularında (hepsiburada.com
 * üzerinde, dinamik sayfa içeriğine rağmen) gözlemlenen benzerlik hep 0.999+ aralığında çıktı —
 * 0.998 bu aralığı rahatça yakalarken, GERÇEKTEN farklı bir senaryo/adımı (ör. farklı bir arama
 * terimi girilen bir fill adımı) yanlışlıkla "zaten var" sanma riskini düşük tutar.
 */
const DEDUP_MIN_SIMILARITY = 0.998;

/**
 * Bir kararı Milvus'a yazarken/ararken saklanan skaler (vektör-dışı) alanlar. `targetRef` BİLEREK
 * BURADA YOKTUR — ref'ler bir run'a özgü geçici numaralardır (ör. "e3"), başka bir sayfada/run'da
 * hiçbir anlamı yoktur. Bunun yerine elementin YAPISAL kimliği (tag/role/accessibleName) saklanır
 * — okuma tarafı (Faz 2), bulunan kaydı GÜNCEL sayfada bu üçlüyle eşleşen bir elemente çevirecektir.
 */
export interface CachedDecisionMetadata {
  action: string;
  targetTag: string;
  targetRole: string;
  targetAccessibleName: string;
  /** fill/type/select_option/... için değer (secret DEĞİLSE gerçek değer, secret ise "{{secret.AD}}" placeholder'ı — bkz. AgentDecision.value dosya başı açıklaması, LLM'in ürettiği ham değer zaten hiçbir zaman gerçek bir secret İÇEREMEZ). */
  value?: string;
  domain: string;
  sourceRunId: string;
}

/** `findSimilar()`'ın döndürdüğü tek bir aday — bkz. dosya başı açıklaması. */
export interface CachedCandidate extends CachedDecisionMetadata {
  /** Milvus'un döndürdüğü kosinüs benzerlik skoru (0-1 arası, 1 = birebir aynı metin). */
  similarity: number;
}

/** Milvus'un arama sonucundaki HAM satır şekli — SDK'nın tam response tipini garanti edemediğimiz için gevşek tutulur (bkz. dosya başı NOT). */
interface RawSearchRow {
  action?: string;
  target_tag?: string;
  target_role?: string;
  target_accessible_name?: string;
  value?: string;
  domain?: string;
  source_run_id?: string;
  score?: number;
  distance?: number;
}

/**
 * Milvus (Vector DB) üzerinde "locator cache" koleksiyonunu yöneten istemci: `recordDecision`
 * (Faz 1, yazma) ve `findSimilar` (Faz 2, okuma — bkz. AgentLoop.tryVectorCacheHit). Resmi
 * `@zilliz/milvus2-sdk-node` paketi kullanılır (Milvus'un gRPC protokolünü elle yazmak, Selenium
 * Grid'in düz REST protokolünün aksine, makul değildir — bkz. SeleniumGridClient dosya başı NOT ile
 * karşılaştırın).
 *
 * KOLEKSİYON ŞEMASI TEMBEL (LAZY) OLUŞTURULUR: vektör boyutu (dim), kullanıcının .env'de seçtiği
 * Ollama embedding modeline göre DEĞİŞİR (bkz. env.ts OLLAMA_EMBEDDING_MODEL dosya başı açıklaması
 * — kodda sabit bir model adı YOKTUR) — bu yüzden koleksiyon, boyutu kesin olarak bilinen İLK
 * embedding üretildiğinde oluşturulur; kodda hardcoded bir dim değeri TUTULMAZ.
 */
export class VectorCacheStore {
  private readonly milvus: MilvusClient;
  private readonly embeddingClient: EmbeddingClient;
  private collectionReady: Promise<void> | null = null;

  constructor(
    milvusUrl: string,
    ollamaUrl: string,
    embeddingModel: string,
    // v2.3 — .env'den (VECTOR_CACHE_EMBED_TIMEOUT_MS) gelir; buradaki varsayılan sadece bu
    // parametre verilmeden doğrudan çağrılan yerler (ör. testler) için bir geri düşüştür.
    embedTimeoutMs: number = DEFAULT_EMBED_TIMEOUT_MS,
  ) {
    this.milvus = new MilvusClient({ address: milvusUrl });
    this.embeddingClient = new EmbeddingClient(ollamaUrl, embeddingModel, embedTimeoutMs);
  }

  /**
   * Bir kararı embed edip Milvus'a yazar. Çağıran taraf (bkz. AgentLoop.recordDecisionInCache) bu
   * çağrıyı BEST-EFFORT olarak sarmalamalıdır — bu metod embedding/Milvus hatalarında fırlatır
   * (silmez), ama bir run'ın PASS/FAIL sonucunu etkilememesi çağıranın sorumluluğundadır.
   */
  async recordDecision(situation: SituationInput, metadata: CachedDecisionMetadata): Promise<void> {
    const text = buildSituationText(situation);
    const vector = await this.embeddingClient.embed(text);

    await this.ensureCollection(vector.length);

    // v2.1 — YAZMADAN ÖNCE tekrar kontrolü: `id` alanı autoID olduğu için her insert YENİ bir
    // satırdır, var olan bir kaydın üzerine yazma/birleştirme YOKTUR — aynı senaryo tekrar tekrar
    // koşulduğunda (kullanıcı gözlemi: "aynı şeyi tekrar çalıştırmada eklemesi mantıksız mı") koleksiyon
    // gereksiz yere şişer. Bu yüzden neredeyse birebir aynısı zaten kayıtlıysa yazmayı atlıyoruz.
    if (await this.isNearDuplicate(vector, metadata)) {
      log.debug(
        { domain: metadata.domain, action: metadata.action },
        'Neredeyse birebir aynı karar zaten cache\'te var, tekrar yazılmadı (dedup)',
      );
      return;
    }

    const insertResult = await this.milvus.insert({
      collection_name: COLLECTION_NAME,
      data: [
        {
          vector,
          action: metadata.action,
          target_tag: metadata.targetTag,
          target_role: metadata.targetRole,
          target_accessible_name: metadata.targetAccessibleName,
          value: metadata.value ?? '',
          domain: metadata.domain,
          source_run_id: metadata.sourceRunId,
          created_at: Date.now(),
        },
      ],
    });

    if (insertResult.status?.error_code && insertResult.status.error_code !== 'Success') {
      throw new Error(`Milvus insert başarısız: ${insertResult.status.error_code} - ${insertResult.status.reason}`);
    }

    log.debug({ domain: metadata.domain, action: metadata.action }, "Karar vector cache'e yazıldı");
  }

  /**
   * Verilen durumla benzer geçmiş kararları arar (v2.0 Faz 2). Sonuçlar benzerlik skoruna göre
   * AZALAN sırada döner (Milvus'un kendi sıralaması) — çağıran taraf (AgentLoop.tryVectorCacheHit)
   * ilk uygun (eşiği geçen VE güncel sayfada gerçek bir elemente karşılık gelen) adayı kullanır.
   *
   * Arama, SADECE AYNI domain'deki kayıtlarla sınırlıdır (`domain` alanına eşitlik filtresi) —
   * bu hem alakasız sonuçları eler hem de farklı sitelerdeki YAPISAL OLARAK benzer ama anlamsal
   * olarak alakasız elementlerin (ör. iki farklı sitenin "Gönder" butonu) yanlışlıkla eşleşme
   * riskini azaltır (bkz. AgentLoop.tryVectorCacheHit dosya başı NOT — asıl güvenlik kapısı orada,
   * eşleşen elementin GÜNCEL sayfada gerçekten bulunması zorunluluğudur, bu filtre EK bir önlemdir).
   *
   * Koleksiyon HENÜZ HİÇ YAZILMAMIŞSA (bkz. recordDecision) burada OLUŞTURULMAZ — arama, var olmayan
   * bir koleksiyonda anlamsızdır; bu durumda boş bir dizi döner (embedding'e bile gerek kalmadan).
   */
  async findSimilar(situation: SituationInput, topK: number): Promise<CachedCandidate[]> {
    const hasCollectionResult = await this.milvus.hasCollection({ collection_name: COLLECTION_NAME });
    if (!hasCollectionResult.value) {
      return [];
    }

    const domain = safeHostname(situation.snapshot.url);
    const text = buildSituationText(situation);
    const vector = await this.embeddingClient.embed(text);

    const searchResult = await this.milvus.search({
      collection_name: COLLECTION_NAME,
      vector,
      limit: topK,
      metric_type: 'COSINE',
      filter: `domain == "${domain}"`,
      output_fields: ['action', 'target_tag', 'target_role', 'target_accessible_name', 'value', 'domain', 'source_run_id'],
    });

    const rows: RawSearchRow[] = searchResult.results ?? [];

    return rows
      .filter((row) => row.action && row.target_tag)
      .map((row) => ({
        action: row.action!,
        targetTag: row.target_tag!,
        targetRole: row.target_role ?? '',
        targetAccessibleName: row.target_accessible_name ?? '',
        value: row.value || undefined,
        domain: row.domain ?? domain,
        sourceRunId: row.source_run_id ?? '',
        // SDK sürümüne göre alan adı 'score' (benzerlik, yüksek=iyi) ya da 'distance' olabilir —
        // COSINE metric_type ile Milvus standalone AUTOINDEX'i genelde 'score' döner, ama emin
        // olmak için ikisini de deniyoruz (bkz. dosya başı RawSearchRow NOT'u).
        similarity: row.score ?? row.distance ?? 0,
      }));
  }

  /**
   * `recordDecision`'ın yazmadan önce çağırdığı tekrar kontrolü (bkz. dosya başı DEDUP_MIN_SIMILARITY
   * açıklaması). SADECE vektör benzerliği YETERLİ DEĞİLDİR — `buildSituationText` bir `fill`
   * adımının GİRİLECEK DEĞERİNİ (ör. arama terimi) embed edilen metne KATMAZ (bkz. situationText.ts
   * dosya başı NOT), yani yapısal olarak çok benzer ama value'su GERÇEKTEN farklı iki karar (ör. iki
   * farklı arama terimi) yüksek benzerlik skoru üretebilir — bu yüzden en yakın adayın `action` ve
   * `value` alanları da BİREBİR eşleşmezse tekrar sayılmaz, normal şekilde yazılır.
   *
   * NOT: burada AYRICA bir `hasCollection` kontrolü YOKTUR — bu metod her zaman `ensureCollection()`
   * çağrısından SONRA çalışır (bkz. çağrı noktası), yani koleksiyonun VAR OLDUĞU zaten garantidir
   * (ya önceden vardı ya da az önce oluşturuldu). Koleksiyon az önce oluşturulmuşsa henüz hiç satırı
   * yoktur — `search` böyle bir koleksiyonda güvenle boş sonuç döner, ekstra bir kontrole gerek yok.
   */
  private async isNearDuplicate(vector: number[], metadata: CachedDecisionMetadata): Promise<boolean> {
    const searchResult = await this.milvus.search({
      collection_name: COLLECTION_NAME,
      vector,
      limit: 1,
      metric_type: 'COSINE',
      filter: `domain == "${metadata.domain}"`,
      output_fields: ['action', 'value'],
    });

    const rows: RawSearchRow[] = searchResult.results ?? [];
    const top = rows[0];
    if (!top) {
      return false;
    }

    const similarity = top.score ?? top.distance ?? 0;
    return (
      similarity >= DEDUP_MIN_SIMILARITY &&
      top.action === metadata.action &&
      (top.value || '') === (metadata.value ?? '')
    );
  }

  /** Koleksiyon zaten varsa hemen döner; yoksa (ilk kullanımda) oluşturup index'ler ve yükler. */
  private ensureCollection(dim: number): Promise<void> {
    if (!this.collectionReady) {
      this.collectionReady = this.doEnsureCollection(dim).catch((err) => {
        // Oluşturma başarısız olduysa bir SONRAKİ çağrının da tekrar denemesi için cache'i sıfırla
        // — aksi halde geçici bir hata (ör. Milvus henüz ayağa kalkmamış), süreç yeniden başlamadan
        // KALICI olarak "denemeyi bile bırakmış" bir duruma yol açar.
        this.collectionReady = null;
        throw err;
      });
    }
    return this.collectionReady;
  }

  private async doEnsureCollection(dim: number): Promise<void> {
    const hasCollectionResult = await this.milvus.hasCollection({ collection_name: COLLECTION_NAME });
    if (hasCollectionResult.value) {
      return;
    }

    await this.milvus.createCollection({
      collection_name: COLLECTION_NAME,
      fields: [
        { name: 'id', data_type: DataType.Int64, is_primary_key: true, autoID: true },
        { name: 'vector', data_type: DataType.FloatVector, dim },
        { name: 'action', data_type: DataType.VarChar, max_length: 32 },
        { name: 'target_tag', data_type: DataType.VarChar, max_length: 32 },
        { name: 'target_role', data_type: DataType.VarChar, max_length: 64 },
        { name: 'target_accessible_name', data_type: DataType.VarChar, max_length: 512 },
        { name: 'value', data_type: DataType.VarChar, max_length: 512 },
        { name: 'domain', data_type: DataType.VarChar, max_length: 255 },
        { name: 'source_run_id', data_type: DataType.VarChar, max_length: 64 },
        { name: 'created_at', data_type: DataType.Int64 },
      ],
    });

    // AUTOINDEX + COSINE: Milvus standalone'ın kendi önerdiği, ayarsız/genel amaçlı index türü —
    // Faz 2'de arama eklendiğinde metric_type burada da (arama isteğinde) COSINE olarak kullanılmalı.
    await this.milvus.createIndex({
      collection_name: COLLECTION_NAME,
      field_name: 'vector',
      index_type: 'AUTOINDEX',
      metric_type: 'COSINE',
    });

    await this.milvus.loadCollectionSync({ collection_name: COLLECTION_NAME });

    log.info({ dim, collection: COLLECTION_NAME }, 'Milvus koleksiyonu ilk kez oluşturuldu');
  }
}
