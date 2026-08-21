import type { DiscoveredElement, PageSnapshot } from '../../domain/types.js';

/**
 * Bir "durumun" (situation) embedding'e verilecek metin temsilini üretir — hem YAZMA tarafında
 * (bir karar Milvus'a kaydedilirken, bkz. VectorCacheStore.recordDecision) HEM DE gelecekteki OKUMA
 * tarafında (bir karar Milvus'ta ARANIRKEN) AYNI fonksiyon kullanılmalıdır — aksi halde iki taraf
 * farklı biçimde serileştirilmiş metinler üretir ve kosinüs benzerliği anlamsız hale gelir.
 *
 * BİLİNÇLİ OLARAK PromptBuilder.buildUserMessage()'dan DAHA DAR bir kapsam kullanılır: değişkenler,
 * secret adları, aksiyon geçmişi, uyarı mesajları ve element attribute/currentValue/options gibi
 * "an'a özgü" detaylar BURAYA DAHİL EDİLMEZ. Amaç, LLM'e TAM bağlamı vermek değil, "bu ne tür bir
 * sayfa/adım" sorusunu FARKLI run'lar arasında karşılaştırılabilir, stabil bir şekilde özetlemektir
 * (ör. iki farklı e-ticaret sitesindeki "giriş yap" adımlarının birbirine benzer vektörler üretmesi
 * istenir; bir input'un o anki değeri gibi an'a özgü bir detay bu benzerliği BOZAR).
 *
 * GÜVENLİK NOTU: bu metin secret DEĞERİ İÇEREMEZ — hem scenario (kullanıcının doğal dil senaryosu,
 * secret değerleri buraya yazılmaz, bkz. SecretsVault) hem de element bilgileri (tag/role/
 * accessibleName — DOM yapısı, girilen değerler değil) yapısal olarak secret taşımaz.
 */
export interface SituationInput {
  scenario: string;
  snapshot: PageSnapshot;
  stepIndex: number;
}

export function buildSituationText(input: SituationInput): string {
  const domain = safeHostname(input.snapshot.url);
  const elementsBlock = input.snapshot.elements.map(formatElementForEmbedding).join('\n');

  return [
    `SENARYO: ${input.scenario}`,
    `ADIM: ${input.stepIndex + 1}`,
    `DOMAIN: ${domain}`,
    `BAŞLIK: ${input.snapshot.title}`,
    'ELEMENTLER:',
    elementsBlock || '(hiç etkileşilebilir element yok)',
  ].join('\n');
}

function formatElementForEmbedding(el: DiscoveredElement): string {
  const parts = [
    `<${el.tag}>`,
    el.role ? `role=${el.role}` : null,
    el.accessibleName ? `name="${el.accessibleName}"` : null,
  ].filter(Boolean);
  return '- ' + parts.join(' ');
}

/** AgentLoop.recordDecisionInCache tarafından, metadata.domain alanı için de kullanılır. */
export function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    // Geçersiz/eksik bir URL ile karşılaşılırsa (teorik olarak olmamalı, ama savunma amaçlı) ham
    // değeri aynen döndürüyoruz — embedding kalitesini düşürür ama run'ı ASLA durdurmaz.
    return url;
  }
}
