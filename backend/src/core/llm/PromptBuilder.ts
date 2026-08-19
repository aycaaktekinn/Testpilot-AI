import type { AgentDecision, DiscoveredElement, PageSnapshot } from '../../domain/types.js';
import type { SecretsVault } from '../secrets/SecretsVault.js';

const SYSTEM_PROMPT = `Sen, doğal dilde yazılmış web test senaryolarını gerçek bir tarayıcıda adım adım yürüten bir test otomasyon ajanısın.

KURALLAR:
1. Sana her adımda: hedef senaryo, o ana kadar yapılan aksiyonların özeti ve sayfanın GÜNCEL DOM element listesi verilecek.
2. SADECE verilen element listesindeki "ref" değerlerini (örn. "e3") hedef olarak kullanabilirsin. Listede olmayan bir ref UYDURMA.
3. Her seferinde TEK bir aksiyon seçersin. Adım adım ilerle, birden fazla aksiyonu tek seferde yapmaya çalışma.
4. Gizli bilgi (şifre, token vb.) girmen gerekiyorsa GERÇEK DEĞERİ ASLA YAZMA. Bunun yerine sana verilen secret adını
   "{{secret.AD}}" biçiminde placeholder olarak value alanına yaz. Değişkenler için "{{var.AD}}" kullanabilir ya da
   sana verilen değişken değerini doğrudan yazabilirsin (değişkenler hassas değildir).
5. Hangi elementin doğru olduğundan EMİN DEĞİLSEN, ya da birden fazla element aynı derecede uygun görünüyorsa,
   düşük bir confidence (<0.5) ver ve action="ask_clarification" seç. Yanlış elemente tıklamaktansa durmak her zaman
   daha güvenlidir.
6. Senaryo tamamen ve başarıyla tamamlandıysa action="finish_success" seç ve summary alanına kısa bir özet yaz.
7. Senaryo gerçekleştirilemiyorsa (örn. element hiç yok, sayfa hata veriyor, senaryo mantıksız) action="finish_failure"
   seç ve summary alanına NEDEN başarısız olduğunu yaz.
7b. Sana "SAYFADAKİ GÖRÜNÜR UYARI/HATA MESAJLARI" başlığı altında bir metin verilirse, bunu MUTLAKA dikkate al.
   Özellikle bir aksiyondan SONRA (ör. bir forma tıkladıktan sonra) böyle bir hata mesajı belirdiyse, aynı aksiyonu
   körü körüne tekrar denemek YERİNE bu mesajı summary'ye yazarak action="finish_failure" seç — bu mesaj,
   otomasyonun neden ilerleyemediğini AÇIKLAR, aynı hatayı bir kez daha görmek için tekrar denemene gerek yoktur.
7c. Bir element için "options" alanı verilmişse (bu, o elementin bir <select> / açılır liste olduğu anlamına gelir),
   action="select_option" seçtiğinde "value" alanına o listeden GÖRDÜĞÜN TAM METNİ (örn. "En düşük fiyat") birebir
   yaz — listede olmayan bir metin uydurma. Sıralama/filtreleme gibi bir istek için uygun bir "options" listesi
   görüyorsan, click veya scroll ile o dropdown'ı aramak yerine DOĞRUDAN select_option kullan.
8. Sadece geçerli, aşağıdaki şemaya uyan TEK BİR JSON nesnesi döndür. Başka hiçbir metin, açıklama veya markdown ekleme.
9. "targetRef", "value" ve "summary" alanları SADECE ilgili aksiyon için gerekliyse yazılır. Gerekli
   değilse o alanı JSON çıktısında TAMAMEN ÇIKAR (hiç yazma) — asla "undefined" kelimesini bir değer
   olarak yazma, bu geçerli bir JSON değeri DEĞİLDİR ve isteğinin reddedilmesine yol açar. Bir alanın
   gerçekten değeri yoksa ve onu çıkarmak istemiyorsan "null" kullanabilirsin, ama tercih edilen yol
   alanı tamamen çıkarmaktır.

JSON şeması (her satırdaki yorum sadece o alanın NE ZAMAN kullanılacağını açıklar; JSON çıktısına
yorum EKLEME, ve o alan bu aksiyon için geçerli değilse alanı hiç yazma):
{
  "reasoning": string,        // kısa gerekçe (secret değeri İÇERMEMELİ)
  "confidence": number,       // 0-1 arası
  "action": "click"|"dblclick"|"fill"|"type"|"press_key"|"select_option"|"check"|"uncheck"|"hover"|"scroll_into_view"|"navigate"|"go_back"|"wait"|"assert_visible"|"assert_text"|"assert_url"|"finish_success"|"finish_failure"|"ask_clarification",
  "targetRef": string,        // örn. "e3" — SADECE element gerektiren aksiyonlarda yaz, aksi halde alanı hiç ekleme
  "value": string,            // SADECE fill/type/select_option/press_key/navigate/wait/assert_text/assert_url için yaz, aksi halde alanı hiç ekleme
  "summary": string           // SADECE finish_success/finish_failure/ask_clarification için yaz, aksi halde alanı hiç ekleme
}

ÖRNEK 1 (targetRef gerektiren bir aksiyon — value/summary YOK, hiç yazılmadı):
{"reasoning": "Kullanıcı adı alanı e3 referansıyla bulundu", "confidence": 0.9, "action": "click", "targetRef": "e3"}

ÖRNEK 2 (value gerektiren ama targetRef/summary gerektirmeyen bir aksiyon):
{"reasoning": "Sayfanın yüklenmesi için kısa bir süre bekleniyor", "confidence": 0.8, "action": "wait", "value": "1000"}

ÖRNEK 3 (summary gerektiren, targetRef/value gerektirmeyen bir aksiyon):
{"reasoning": "Senaryodaki tüm adımlar başarıyla tamamlandı", "confidence": 0.95, "action": "finish_success", "summary": "Kullanıcı başarıyla giriş yaptı ve sepete ürün eklendi"}`;

export interface PromptContext {
  scenario: string;
  startUrl: string;
  snapshot: PageSnapshot;
  history: HistoryEntry[];
  vault: SecretsVault;
  stepIndex: number;
  maxSteps: number;
}

export interface HistoryEntry {
  stepIndex: number;
  decision: Pick<AgentDecision, 'action' | 'targetRef' | 'reasoning'>;
  maskedValue?: string;
  resultOk: boolean;
  resultMessage: string;
}

export function buildSystemMessage() {
  return { role: 'system' as const, content: SYSTEM_PROMPT };
}

export function buildUserMessage(ctx: PromptContext) {
  const { variableNames, secretNames, variables } = ctx.vault.describeForPrompt();

  const elementsBlock = ctx.snapshot.elements.map(formatElement).join('\n');
  // Sayfada görünür ama tıklanabilir OLMAYAN hata/uyarı/bildirim metinleri (bkz. PageSnapshot.alerts
  // dosya başı açıklaması) — hepsiburada.com üzerinde canlı olarak gözlemlenen bir sorunu çözüyor:
  // bu bölüm boşsa hiç eklenmiyor (gereksiz "yok" satırıyla prompt'u şişirmemek için).
  const alertsBlock = ctx.snapshot.alerts.length
    ? `\nSAYFADAKİ GÖRÜNÜR UYARI/HATA MESAJLARI (tıklanabilir değiller, sadece bilgi amaçlı):\n${ctx.snapshot.alerts.map((a) => `- ${a}`).join('\n')}\n`
    : '';
  const historyBlock = ctx.history.length
    ? ctx.history
        .map(
          (h) =>
            `#${h.stepIndex} ${h.decision.action}${h.decision.targetRef ? ' -> ' + h.decision.targetRef : ''}` +
            `${h.maskedValue ? ' value=' + JSON.stringify(h.maskedValue) : ''} | sonuç: ${h.resultOk ? 'OK' : 'HATA'} - ${h.resultMessage}`,
        )
        .join('\n')
    : '(henüz aksiyon yok)';

  const content = `SENARYO (doğal dil):
"""
${ctx.scenario}
"""

Başlangıç URL: ${ctx.startUrl}
Şu anki adım: ${ctx.stepIndex + 1} / azami ${ctx.maxSteps}

KULLANILABİLİR DEĞİŞKENLER (hassas değil, doğrudan kullanılabilir):
${variableNames.length ? JSON.stringify(variables) : '(yok)'}

KULLANILABİLİR SECRET ADLARI (değerlerini SADECE "{{secret.AD}}" olarak referans ver, gerçek değeri asla yazma):
${secretNames.length ? secretNames.join(', ') : '(yok)'}

ŞİMDİYE KADARKİ AKSİYON GEÇMİŞİ:
${historyBlock}

GÜNCEL SAYFA:
URL: ${ctx.snapshot.url}
Başlık: ${ctx.snapshot.title}
${alertsBlock}
GÜNCEL ETKİLEŞİLEBİLİR ELEMENTLER (sadece bu ref'leri kullan):
${elementsBlock || '(hiç etkileşilebilir element bulunamadı)'}

Bir sonraki tek aksiyonu, sadece JSON olarak döndür.`;

  return { role: 'user' as const, content };
}

function formatElement(el: DiscoveredElement): string {
  const attrs = Object.entries(el.attributes)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(' ');
  const parts = [
    el.ref,
    `<${el.tag}>`,
    `role=${el.role ?? '-'}`,
    el.accessibleName ? `name=${JSON.stringify(el.accessibleName)}` : null,
    el.currentValue ? `value=${JSON.stringify(el.currentValue)}` : null,
    // hepsiburada.com "sırala" dropdown'ı regresyonu (bkz. browserDiscoveryScript.ts dosya başı
    // NOT): bir <select>'in seçenekleri burada AÇIKÇA listelenmezse, LLM select_option için
    // hangi "value"yu (Playwright'ın GÖRÜNEN metinle eşleştirdiği, bkz. ActionExecutor.select_option)
    // yazması gerektiğini asla bilemez.
    el.options?.length ? `options=${JSON.stringify(el.options)}` : null,
    el.frame !== 'main' ? `frame=${el.frame}` : null,
    attrs || null,
    el.enabled ? null : '[DISABLED]',
  ].filter(Boolean);
  return '- ' + parts.join(' ');
}
