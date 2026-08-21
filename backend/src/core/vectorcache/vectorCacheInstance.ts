import { env } from '../../config/env.js';
import { VectorCacheStore } from './VectorCacheStore.js';

/**
 * Süreç ömrü boyunca yaşayan tek bir paylaşılan örnek (bkz. legacyTestServiceInstance.ts ile aynı
 * desen) — AgentLoop bunu import edip kullanır. `env.VECTOR_CACHE_ENABLED=false` iken (varsayılan)
 * `null`'dır — Milvus'a hiçbir bağlantı denemesi yapılmaz, ne AgentLoop'ta ne başka bir yerde.
 *
 * `env.OLLAMA_EMBEDDING_MODEL!` — burada `!` GÜVENLİDİR: env.ts'in `.superRefine()` doğrulaması
 * zaten VECTOR_CACHE_ENABLED=true iken OLLAMA_EMBEDDING_MODEL'in dolu olmasını ZORUNLU kılar; bu
 * noktaya sadece o doğrulamadan geçmiş bir env objesiyle ulaşılabilir.
 */
export const vectorCacheStore: VectorCacheStore | null = env.VECTOR_CACHE_ENABLED
  ? new VectorCacheStore(env.MILVUS_URL, env.OLLAMA_URL, env.OLLAMA_EMBEDDING_MODEL!)
  : null;
