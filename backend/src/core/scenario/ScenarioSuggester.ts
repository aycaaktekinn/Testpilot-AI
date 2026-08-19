import type { LlmProvider } from '../llm/LlmProvider.js';
import { BrowserManager } from '../browser/BrowserManager.js';
import { DomAnalyzer } from '../dom/DomAnalyzer.js';
import { dismissConsentBanners } from '../browser/ConsentBannerHandler.js';
import { GeneratedTestStore } from '../legacy/GeneratedTestStore.js';
import { TestRunStore } from '../legacy/TestRunStore.js';
import { defaultRunOptions } from '../../config/env.js';
import { ValidationError } from '../../domain/errors.js';
import { createLogger } from '../../config/logger.js';
import type { DiscoveredElement } from '../../domain/types.js';

const log = createLogger('ScenarioSuggester');

export interface ScenarioSuggestion {
  title: string;
  scenario: string;
}

interface PastScenarioEntry {
  scenario: string;
  status: 'passed' | 'failed' | 'unknown';
}

// Element listesinin LLM'e giden bölümünü makul bir boyutta tutmak için — DomAnalyzer zaten
// options.maxElementsPerStep (varsayılan 80) ile üst sınır koyuyor, burada AYRICA daha küçük bir
// alt-limit uyguluyoruz çünkü bu tek seferlik bir "genel bakış" isteği, adım adım karar değil.
const MAX_ELEMENTS_IN_PROMPT = 60;

// Aynı sitede (hostname) geçmişte kaç senaryoya kadar prompt'a dahil edilsin — hem prompt
// boyutunu makul tutmak hem de en GÜNCEL/İLGİLİ geçmişe odaklanmak için (liste zaten en yeniden
// en eskiye sıralı geliyor).
const MAX_HISTORY_ENTRIES = 8;

// "Get More Suggestions" akışında frontend, kullanıcıya bu oturumda ZATEN gösterilmiş senaryo
// metinlerini geri gönderir (bkz. suggest() üçüncü parametre) — LLM bunları tekrarlamasın diye.
// Kullanıcı arka arkaya çok kez "daha fazla öneri" isterse liste büyüyebilir; prompt boyutunu
// makul tutmak için sadece EN SON eklenenleri (en ilgili/güncel olanlar) dahil ediyoruz.
const MAX_ALREADY_SUGGESTED_IN_PROMPT = 20;

// AgentLoop.run()'daki adım-adım karar döngüsüyle (MAX_LLM_RETRIES_PER_STEP) AYNI desen: LLM tek
// seferde geçersiz/ayrıştırılamaz bir yanıt verirse tüm isteği hemen başarısız SAYMAK yerine,
// hatayı modele geri bildirip düzeltme şansı veriyoruz. Öncesinde bu akışta HİÇ retry yoktu — tek
// bir "beklenmedik format" yanıtı doğrudan kullanıcıya "AI geçerli bir öneri listesi döndürmedi"
// hatası olarak yansıyordu.
const MAX_SUGGEST_RETRIES = 2;

// LlmProvider'ların (OpenRouterProvider/GeminiProvider) VARSAYILAN max_tokens değeri (1024),
// AgentLoop'un adım-adım kararları (tek küçük JSON nesnesi) için ayarlanmış — 3-6 senaryo içeren,
// her biri title + tam bir paragraf senaryo metni taşıyan bir JSON DİZİSİ için YETERSİZ. Canlıda
// GÖZLEMLENEN gerçek hata tam olarak buydu: yanıt "Unterminated string in JSON" ile ortasında
// kesiliyordu (model 1024 token bütçesini dizi tamamlanmadan tüketiyordu) — ve bu bir "kötü format"
// hatası OLMADIĞI için MAX_SUGGEST_RETRIES'teki yeniden deneme de İŞE YARAMIYORDU (her deneme AYNI
// bütçeyle AYNI noktada kesiliyordu). Burada AÇIKÇA daha yüksek bir bütçe istiyoruz — provider'lar
// ayrıca kendi taraflarında da finish_reason="length" (kesilme) durumunda otomatik olarak daha da
// yüksek bir bütçeyle tekrar deniyor (bkz. OpenRouterProvider/GeminiProvider.complete()), bu ikisi
// birbirini TAMAMLAYAN, bağımsız iki güvenlik katmanı.
const SUGGEST_MAX_TOKENS = 2048;

const SYSTEM_PROMPT = `Sen bir web sitesini inceleyip QA mühendisleri için gerçekçi test senaryoları öneren bir asistansın.
Sana bir sayfanın başlığı, URL'si, üzerindeki etkileşilebilir elementlerin bir listesi ve (varsa) bu
sitede DAHA ÖNCE çalıştırılmış senaryoların bir özeti verilecek.

KURALLAR:
1. SADECE verilen elementlere dayanarak mantıklı senaryolar öner — sayfada gerçekten karşılığı olmayan bir özelliği (ör. sayfada "sepete ekle" hiç yoksa böyle bir senaryo) UYDURMA.
2. 3 ile 6 arasında senaryo öner. Sayfa çok basitse (ör. sadece birkaç link) daha az öneri vermen tamamen kabul edilebilir.
3. Sayfada BİRDEN FAZLA farklı işlevsel alan tespit edersen (ör. hem bir giriş/login formu HEM DE bir arama/sepet/ürün akışı), bunların HEPSİNİ TEK bir dev senaryoda birleştirme — her işlevsel alan için AYRI, odaklı bir senaryo öner (ör. biri "Giriş yap" senaryosu, biri ayrı bir "Ürün ara ve sepete ekle" senaryosu). Kullanıcı bunları istediği gibi tek tek veya art arda kullanabilir.
4. "GEÇMİŞTE ÇALIŞTIRILAN SENARYOLAR" verilmişse bunları MUTLAKA dikkate al: (a) neredeyse BİREBİR AYNI bir senaryoyu TEKRAR önerme — onun yerine farklı bir açıdan (farklı bir alan, farklı bir veri, bir sonraki adım) devam eden YENİ bir senaryo öner; (b) daha önce BAŞARISIZ (failed) olmuş bir senaryo varsa, onu tekrar aynen önermek yerine, aynı hedefe farklı/daha basit bir yoldan ulaşmayı deneyen bir alternatif önerebilirsin.
4b. "BU OTURUMDA ZATEN ÖNERİLMİŞ SENARYOLAR" verilmişse (kullanıcı "daha fazla öneri" istediğinde gönderilir), bunların HİÇBİRİNİ birebir veya çok benzer şekilde TEKRAR ÖNERME — kullanıcı zaten bunları görmüş durumda. Bunun yerine sayfada henüz değinilmemiş başka bir işlevsel alandan, farklı bir veri kombinasyonundan veya farklı bir uç durumdan tamamen YENİ senaryolar üret. Eğer sayfa gerçekten bu kadar çeşitliliği desteklemiyorsa, daha az sayıda (hatta 1) yeni senaryo önermen kabul edilebilir — ASLA zaten önerilmiş bir senaryoyu tekrar etme.
5. Sayfada en az bir metin giriş alanı (ör. email/arama/form input) varsa, önerilerden EN AZ BİRİ mutlaka bir NEGATİF/UÇ DURUM (edge case) testi olmalı — ör. email alanına geçersiz/emoji içeren bir metin girip doğru hata mesajının çıktığını doğrulamak, zorunlu bir alanı boş bırakıp göndermeyi denemek, çok uzun bir metin girmek gibi. Bu senaryonun title'ında bunun bir "negatif test" olduğu anlaşılmalı (ör. "Geçersiz E-posta ile Doğrulama").
6. Bir senaryo giriş/şifre gerektiriyorsa (bir login formu tespit edildiyse), senaryo metninde GERÇEK bir değer YAZMA — bunun yerine "{{var.EMAIL}}" ve "{{secret.PASSWORD}}" gibi placeholder'lar kullan (kullanıcı bunları kendi değerleriyle Variables & Secrets tablosunda dolduracak). Negatif/uç durum testlerinde (ör. "email alanına emoji gir") bu KURAL GEÇERLİ DEĞİL — bu durumda geçersiz test verisini (ör. "😀🎉" veya "abc") doğrudan senaryo metnine yazabilirsin, çünkü bu gerçek bir kimlik bilgisi değil, kasıtlı olarak geçersiz bir test girdisidir.
7. Her senaryonun "scenario" alanı, kullanıcının bu sistemde normalde KENDİSİ yazacağı doğal dilde, adım adım anlatan bir paragraf olmalı (ör. "Arama kutusuna X yaz, ara, ilk sonuca tıkla ve ürün sayfasının açıldığını doğrula.").
8. "title" alanı en fazla 6 kelimelik kısa bir başlık olmalı.
9. SADECE geçerli bir JSON dizisi döndür. Başka HİÇBİR metin, açıklama veya markdown ekleme.
10. "KULLANICININ ÖZEL İSTEĞİ" verilmişse (ör. "login sayfasıyla ilgili senaryo üret", "sadece sepet akışına odaklan"), önerilerini ÖNCELİKLE bu isteğe göre şekillendir — mümkünse üretilen TÜM senaryolar bu isteğe odaklı olsun (KURAL 2'deki 3-6 aralığı yine geçerli). Ama KURAL 1 burada da geçerlidir: sayfada isteğin karşılığı olan bir alan/özellik GERÇEKTEN yoksa (ör. kullanıcı "login" istedi ama sayfada hiçbir giriş formu yoksa) bunu UYDURMA — bu durumda kullanıcıya bunu FARK ETTİRECEK şekilde (ör. bir senaryonun title'ında "Not: Sayfada Login Formu Yok") sayfada gerçekten var olan en yakın/ilgili alanlara dayalı normal önerilerini sun.

JSON şeması: [{ "title": string, "scenario": string }, ...]`;

/**
 * Kullanıcının verdiği bir URL'yi GERÇEKTEN ziyaret edip (tek seferlik, hiçbir aksiyon almadan
 * sadece DOM'u tarayarak) sayfa yapısını çıkarır, bu sitede DAHA ÖNCE çalıştırılmış senaryoları
 * (varsa) geçmişten okur, ardından LLM'den bu bağlama göre çeşitlendirilmiş (farklı işlevsel
 * alanlar + en az bir negatif/uç durum testi) gerçekçi senaryo önerileri ister. AgentLoop'un
 * adım-adım çalışma mantığından TAMAMEN ayrı, bağımsız bir akıştır.
 */
export class ScenarioSuggester {
  private readonly generatedTestStore = new GeneratedTestStore();
  private readonly testRunStore = new TestRunStore();

  constructor(private readonly llm: LlmProvider) {}

  /**
   * @param existingScenarios "Get More Suggestions" akışında frontend'in bu oturumda kullanıcıya
   *   ZATEN gösterdiği senaryo metinleri — LLM'e "bunları tekrar önerme" talimatıyla birlikte
   *   iletilir (bkz. SYSTEM_PROMPT kural 4b). Normal (ilk) öneri isteğinde boş gelir.
   * @param focus Kullanıcının "sadece login sayfasıyla ilgili senaryo üret" gibi serbest metin bir
   *   yönlendirmesi — opsiyonel, boşsa AI eskisi gibi sayfanın GENELİNE göre öneriyor (bkz.
   *   SYSTEM_PROMPT kural 10).
   */
  async suggest(
    url: string,
    headed = true,
    existingScenarios: string[] = [],
    focus = '',
  ): Promise<ScenarioSuggestion[]> {
    const [{ title, elements }, history] = await Promise.all([
      this.scanPage(url, headed),
      this.getRelevantHistory(url),
    ]);

    if (elements.length === 0) {
      throw new ValidationError('Sayfada hiç etkileşilebilir element bulunamadı; senaryo önerisi çıkarılamadı.');
    }

    const baseMessages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: buildUserMessage(url, title, elements, history, existingScenarios, focus) },
    ];

    // `lastFailureKind`, döngü tükendiğinde kullanıcıya HANGİ nihai hata mesajının gösterileceğini
    // belirler: bir ağ/istek hatasıyla mı yoksa bir ayrıştırma hatasıyla mı sona erdik — bu ikisi
    // kullanıcı için farklı anlamlar taşır (biri "AI'ya ulaşılamadı", diğeri "AI beklenmedik bir
    // şey döndürdü"), bu yüzden tek bir genel mesaja indirgemiyoruz.
    let lastFailureKind: 'network' | 'parse' = 'network';
    let lastError = '';

    for (let attempt = 0; attempt <= MAX_SUGGEST_RETRIES; attempt++) {
      const messages = [...baseMessages];
      if (attempt > 0) {
        messages.push({
          role: 'user' as const,
          content: `Önceki yanıtın geçersizdi: ${lastError}. SADECE geçerli bir JSON dizisi döndür — başka HİÇBİR açıklama, markdown ya da metin ekleme.`,
        });
      }

      let raw: string;
      try {
        raw = await this.llm.complete(messages, { temperature: 0.4, maxTokens: SUGGEST_MAX_TOKENS });
      } catch (err) {
        lastFailureKind = 'network';
        lastError = err instanceof Error ? err.message : String(err);
        log.warn({ err, url, attempt }, 'Senaryo önerisi için LLM çağrısı başarısız, tekrar deneniyor');
        continue;
      }

      const parsed = tryParseSuggestions(raw);
      if (parsed.ok) {
        return parsed.suggestions;
      }

      lastFailureKind = 'parse';
      lastError = parsed.error;
      // NOT: modelin ham çıktısını loglamak GÜVENLİDİR — bu akış hiçbir secret DEĞERİNİ LLM'e
      // göndermez (senaryo metinleri en fazla "{{secret.AD}}" gibi placeholder'lar içerebilir,
      // bkz. SYSTEM_PROMPT kural 6). Bu satır olmadan "AI geçerli bir öneri listesi döndürmedi"
      // hatasının NEDEN oluştuğu (kod bloğu dışı düz metin mi, yanlış JSON şekli mi, vb.)
      // terminal loglarından ASLA anlaşılamıyordu.
      log.warn(
        { url, attempt, error: parsed.error, rawResponsePreview: raw.slice(0, 800) },
        'AI önerisi ayrıştırılamadı, tekrar deneniyor',
      );
    }

    if (lastFailureKind === 'network') {
      throw new ValidationError('AI\'dan senaryo önerisi alınamadı. Lütfen tekrar deneyin.');
    }
    throw new ValidationError(`AI geçerli bir öneri listesi döndürmedi (${MAX_SUGGEST_RETRIES + 1} deneme sonrası). Son hata: ${lastError}`);
  }

  /**
   * Aynı sitede (hostname eşleşmesiyle — tam URL değil, çünkü kullanıcı aynı sitede farklı bir
   * sayfadan/path'ten başlamış olabilir) DAHA ÖNCE üretilmiş senaryoları, varsa en son koşum
   * durumlarıyla (passed/failed) birlikte döner. Best-effort: diskten okuma başarısız olursa
   * (ör. henüz hiç test çalıştırılmamışsa) sessizce boş liste döner — bu ÖLÜMCÜL bir hata değil,
   * sadece "geçmiş yok" anlamına gelir.
   */
  private async getRelevantHistory(url: string): Promise<PastScenarioEntry[]> {
    let targetHost: string;
    try {
      targetHost = new URL(url).hostname;
    } catch {
      return [];
    }

    try {
      const [allTests, allRuns] = await Promise.all([this.generatedTestStore.list(), this.testRunStore.list()]);

      const matchingTests = allTests.filter((test) => {
        try {
          return new URL(test.url).hostname === targetHost;
        } catch {
          return false;
        }
      });

      return matchingTests.slice(0, MAX_HISTORY_ENTRIES).map((test) => {
        const run = allRuns.find((r) => r.testFile === test.fileName);
        return {
          scenario: test.scenario,
          status: run?.status ?? 'unknown',
        };
      });
    } catch (err) {
      log.debug({ err, url }, 'Geçmiş senaryo geçmişi okunamadı (yok sayıldı)');
      return [];
    }
  }

  private async scanPage(url: string, headed: boolean): Promise<{ title: string; elements: DiscoveredElement[] }> {
    const browserManager = new BrowserManager();
    const domAnalyzer = new DomAnalyzer();

    // headless VARSAYILAN OLARAK KULLANILMAZ (headed=true varsayılan): hepsiburada.com üzerinde
    // canlı olarak gözlemlendi — headless Chromium'u bot-koruması tarafından tespit edip boş/
    // engellenmiş bir sayfa döndürüyor (0 element bulunuyor), AYNI site AYNI kodla headed modda
    // sorunsuz çalışıyor (bu projedeki TÜM gerçek test koşumları zaten varsayılan olarak headed
    // modda çalıştırılıyor — bkz. frontend "Headed Mode" checkbox'ının varsayılan değeri). Bu
    // yüzden burada da aynı, kanıtlanmış-çalışan varsayılanı kullanıyoruz.
    // captureVideo/Screenshot/Trace BİLİNÇLİ OLARAK false: bu, gerçek bir test run'ı değil,
    // sadece sayfayı "gözden geçirmek" için tek seferlik bir ziyaret — hiçbir kanıt/artefakt
    // toplamaya gerek yok.
    const options = {
      ...defaultRunOptions,
      headless: !headed,
      captureScreenshot: false,
      captureVideo: false,
      captureTrace: false,
    };

    try {
      const page = await browserManager.launch(options);
      try {
        await page.goto(url, { timeout: options.navigationTimeoutMs, waitUntil: 'domcontentloaded' });
        await dismissConsentBanners(page);
        const { snapshot } = await domAnalyzer.analyze(page, options);
        return { title: snapshot.title, elements: snapshot.elements };
      } finally {
        await browserManager.close();
      }
    } catch (err) {
      log.warn({ err, url }, 'Sayfa taranamadı (senaryo önerisi için)');
      throw new ValidationError('Sayfa ziyaret edilemedi. URL\'yi kontrol edip tekrar deneyin.');
    }
  }
}

function buildUserMessage(
  url: string,
  title: string,
  elements: DiscoveredElement[],
  history: PastScenarioEntry[],
  existingScenarios: string[] = [],
  focus = '',
): string {
  const elementsBlock = elements
    .slice(0, MAX_ELEMENTS_IN_PROMPT)
    .map((el) => {
      const attrs = Object.entries(el.attributes)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ');
      const parts = [
        `<${el.tag}>`,
        `role=${el.role ?? '-'}`,
        el.accessibleName ? `name=${JSON.stringify(el.accessibleName)}` : null,
        attrs || null,
      ].filter(Boolean);
      return '- ' + parts.join(' ');
    })
    .join('\n');

  // Boşsa bu bölümü hiç eklemiyoruz (gereksiz "geçmiş yok" satırıyla prompt'u şişirmemek için) —
  // bkz. PromptBuilder.ts'teki alertsBlock ile aynı desen.
  const historyBlock = history.length
    ? `\nGEÇMİŞTE BU SİTEDE ÇALIŞTIRILAN SENARYOLAR (en yeniden en eskiye):\n${history
        .map((h) => `- [${h.status === 'passed' ? 'BAŞARILI' : h.status === 'failed' ? 'BAŞARISIZ' : 'BİLİNMİYOR'}] ${truncate(h.scenario, 200)}`)
        .join('\n')}\n`
    : '';

  // Kapasiteyi aşan kısmı değil, EN SON eklenenleri tutuyoruz (slice(-N)) — kullanıcı arka arkaya
  // "daha fazla öneri" isterse en alakalı/güncel bağlam bu olur.
  const alreadySuggestedBlock = existingScenarios.length
    ? `\nBU OTURUMDA ZATEN ÖNERİLMİŞ SENARYOLAR (bunları TEKRARLAMA, tamamen YENİ senaryolar üret — bkz. kural 4b):\n${existingScenarios
        .slice(-MAX_ALREADY_SUGGESTED_IN_PROMPT)
        .map((s) => `- ${truncate(s, 200)}`)
        .join('\n')}\n`
    : '';

  // Boşsa (kullanıcı bir yönlendirme yazmadıysa) bu bölümü hiç eklemiyoruz — AI eskisi gibi
  // sayfanın GENELİNE göre öneriyor (bkz. SYSTEM_PROMPT kural 10).
  const focusBlock = focus.trim() ? `\nKULLANICININ ÖZEL İSTEĞİ: "${truncate(focus, 300)}"\n` : '';

  return `URL: ${url}\nBaşlık: ${title}\n${historyBlock}${alreadySuggestedBlock}${focusBlock}\nETKİLEŞİLEBİLİR ELEMENTLER:\n${elementsBlock || '(hiç bulunamadı)'}\n\nBu sayfa için, KURALLARA uygun şekilde çeşitlendirilmiş senaryolar öner.`;
}

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

type ParseResult = { ok: true; suggestions: ScenarioSuggestion[] } | { ok: false; error: string };

/**
 * ESKİDEN (throw eden parseSuggestions) tek bir ayrıştırma denemesi vardı: markdown kod bloğu
 * varsa onu çıkar, yoksa metnin TAMAMINI JSON.parse et — model talimata uymayıp JSON'un
 * öncesine/sonrasına düz metin eklerse (ör. "İşte öneriler:\n[...]") bu HEMEN başarısız oluyordu.
 * Şimdi, suggest()'teki retry döngüsüyle birlikte çalışacak şekilde throw ETMİYOR — bunun yerine
 * SIRAYLA birkaç aday metni dener (kod bloğu içeriği → metnin tamamı → ilk '[' ile son ']'
 * arasındaki kesit) ve İLK başarılı olanı kullanır; hiçbiri işe yaramazsa son hatayı döner.
 */
function tryParseSuggestions(raw: string): ParseResult {
  const trimmed = raw.trim();
  const candidates: string[] = [];

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    candidates.push(fenceMatch[1].trim());
  }

  candidates.push(trimmed);

  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    candidates.push(trimmed.slice(firstBracket, lastBracket + 1));
  }

  let lastError = 'AI geçerli bir JSON dizisi döndürmedi.';

  for (const candidate of candidates) {
    let json: unknown;
    try {
      json = JSON.parse(candidate);
    } catch (err) {
      lastError = err instanceof Error ? `JSON ayrıştırma hatası: ${err.message}` : 'JSON ayrıştırılamadı.';
      continue;
    }

    if (!Array.isArray(json)) {
      lastError = 'AI bir dizi yerine başka bir JSON şekli döndürdü.';
      continue;
    }

    const suggestions: ScenarioSuggestion[] = [];
    for (const item of json) {
      if (isSuggestionShape(item)) {
        suggestions.push({ title: item.title, scenario: item.scenario });
      }
    }

    if (suggestions.length === 0) {
      lastError = 'Dizideki öğeler beklenen { title, scenario } şeklinde değildi.';
      continue;
    }

    return { ok: true, suggestions: suggestions.slice(0, 6) };
  }

  return { ok: false, error: lastError };
}

function isSuggestionShape(value: unknown): value is ScenarioSuggestion {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.title === 'string' && typeof candidate.scenario === 'string';
}
