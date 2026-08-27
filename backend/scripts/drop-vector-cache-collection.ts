import 'dotenv/config';
import { MilvusClient } from '@zilliz/milvus2-sdk-node';

/**
 * Tek seferlik bakım scripti — embedding modeli değiştiğinde (ör. qwen3-embedding:0.6b'den
 * qwen3-embedding-8b'ye geçiş) Milvus'taki "testpilot_locator_cache" koleksiyonunu siler.
 *
 * NEDEN GEREKLİ: koleksiyon vektör boyutu (dim) İLK yazıldığı anda, o anki embedding modelinin
 * ürettiği vektör uzunluğuna göre SABİT olarak oluşturulur (bkz. VectorCacheStore.doEnsureCollection)
 * ve Milvus'ta bir koleksiyonun dim'i SONRADAN DEĞİŞTİRİLEMEZ. Embedding modelini değiştirdiğinizde
 * yeni model muhtemelen FARKLI boyutta vektör üretir — bu da her insert'te
 * "num_rows (X) ... not equal to passed num_rows (1)" hatasına yol açar. Ayrıca eski koleksiyondaki
 * vektörler ESKİ modelin embedding uzayına ait olduğu için, dim aynı kalsaydı bile YENİ modelin
 * vektörleriyle karşılaştırmak anlamsız olurdu — yani bu, sadece bir hata düzeltmesi değil, model
 * değişince yapılması GEREKEN doğru işlemdir: koleksiyon silinir, bir sonraki karar kaydedildiğinde
 * (recordDecision) yeni modelin boyutuyla otomatik olarak YENİDEN oluşturulur (bkz. ensureCollection
 * — lazy/tembel oluşturma, kodda hiçbir şeyin elle değiştirilmesine gerek yok).
 *
 * Çalıştırma (backend/ klasöründen, .env'deki MILVUS_URL'i kullanır):
 *   npx tsx scripts/drop-vector-cache-collection.ts
 */

const COLLECTION_NAME = 'testpilot_locator_cache';

async function main() {
  const milvusUrl = process.env.MILVUS_URL || 'http://localhost:19530';
  console.log(`Milvus'a bağlanılıyor: ${milvusUrl}`);
  const milvus = new MilvusClient({ address: milvusUrl });

  const hasCollectionResult = await milvus.hasCollection({ collection_name: COLLECTION_NAME });
  if (!hasCollectionResult.value) {
    console.log(`"${COLLECTION_NAME}" koleksiyonu zaten yok, yapılacak bir şey yok.`);
    return;
  }

  console.log(`"${COLLECTION_NAME}" koleksiyonu siliniyor...`);
  const dropResult: any = await milvus.dropCollection({ collection_name: COLLECTION_NAME });
  // Milvus Node SDK sürümüne göre hata kodu ya doğrudan sonuçta ya da `status` altında gelebilir —
  // ikisini de kontrol ediyoruz ki gerçek bir hatayı kaçırmayalım.
  const errorCode = dropResult?.error_code ?? dropResult?.status?.error_code;
  const reason = dropResult?.reason ?? dropResult?.status?.reason;
  if (errorCode && errorCode !== 'Success') {
    throw new Error(`Silme başarısız: ${errorCode} - ${reason}`);
  }

  console.log(
    `Silindi. Bir sonraki başarılı adımda (AgentLoop.recordDecisionInCache) koleksiyon, ` +
      `yeni embedding modelinin vektör boyutuyla otomatik olarak yeniden oluşturulacak.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Hata:', err);
    process.exit(1);
  });
