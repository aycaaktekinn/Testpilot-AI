import path from 'node:path';
import { rm } from 'node:fs/promises';
import type { BrowserContext } from 'playwright';
import { nanoid } from 'nanoid';
import type { LlmProvider } from '../llm/LlmProvider.js';
import { BrowserManager } from '../browser/BrowserManager.js';
import { DomAnalyzer } from '../dom/DomAnalyzer.js';
import { dismissConsentBanners } from '../browser/ConsentBannerHandler.js';
import { GeneratedTestStore } from '../legacy/GeneratedTestStore.js';
import { TestRunStore } from '../legacy/TestRunStore.js';
import { AgentLoop } from '../agent/AgentLoop.js';
import { env, defaultRunOptions } from '../../config/env.js';
import { ValidationError } from '../../domain/errors.js';
import { createLogger } from '../../config/logger.js';
import type { DiscoveredElement } from '../../domain/types.js';

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/**
 * v3.3 — Sayfa giriş (login) gerektiriyorsa, taramadan ÖNCE çalıştırılacak kısa bir AI destekli
 * giriş adımını tanımlar (bkz. ScenarioSuggester.performLogin dosya başı açıklaması). `scenario`,
 * gerçek test senaryolarıyla AYNI serbest metin formatındadır ve AYNI `{{var.AD}}`/`{{secret.AD}}`
 * placeholder kuralını kullanır (bkz. SYSTEM_PROMPT kural 6) — GERÇEK bir şifre asla LLM'e
 * gönderilmez, sadece placeholder adı gönderilir (bkz. SecretsVault.resolve/maskForLog deseni).
 */
export interface ScenarioSuggestionLoginConfig {
  /** Giriş formunun bulunduğu sayfa — boşsa/verilmezse `suggest()`'e verilen ana URL kullanılır. */
  url?: string;
  /** "E-posta alanına {{var.EMAIL}} yaz, şifre alanına {{secret.PASSWORD}} yaz, Giriş'e tıkla..." gibi doğal dil adımlar. */
  scenario: string;
  variables?: Record<string, string>;
  secrets?: Record<string, string>;
}

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

// v3.37 — bkz. sohbet notu: "Scenario Suggestions ... reasoning: String must contain at most 600
// character(s)" hatası + "dom tree deki verileri sadeleştir, gereksiz elementleri kaldır".
// performLogin() (aşağıda) AgentLoop.run()'ı `defaultRunOptions.maxElementsPerStep` (admin panelden
// GENEL test koşumları için ayarlanmış, canlıda 80'in ÜZERİNE çıkarılmış olabilen bir değer) ile
// çalıştırıyordu — bu giriş ön-adımı için GEREKSİZ derecede yüksek: sonuçta sadece bir giriş
// formunu (ve olsa olsa birkaç yönlendirme adımını) tamamlaması gerekiyor, kalabalık bir menüdeki
// (ör. "Tüm İşlemler" altında onlarca link) TÜM elementleri görmesine hiç gerek yok. Admin'in genel
// koşumlar için seçtiği değerden DAHA YÜKSEK bir sayı asla kullanılmasın diye `Math.min` ile
// sınırlanıyor — admin bilerek DAHA DÜŞÜK bir değer seçtiyse o'na saygı gösterilir.
const MAX_ELEMENTS_IN_LOGIN_STEP = 50;

// v3.41 — bkz. sohbet notu: loop_detected düzeltmesinden SONRA login artık başarıyla tamamlanıyor,
// ama bu SEFER "Sayfada hiç etkileşilebilir element bulunamadı" hatası alınmaya başlandı (terminal
// logu: totalCandidates: 10, returnedElements: 0). Kök sebep: scanPage() (aşağıda), performLogin()
// sırasında ULAŞILAN ekranı DEĞİL, `suggest()`'e verilen ORİJİNAL `url`'i (bu vakada login
// sayfasının kendisi) storageState (çerezler) ile YENİDEN ziyaret ediyor — beklenti, geçerli bir
// oturumla o URL'e gidince sitenin otomatik olarak giriş-sonrası ekrana yönlendirmesi. Bu tür bir
// istemci-taraflı (SPA) yönlendirme/render `waitUntil: 'domcontentloaded'` tetiklendiği ANDA henüz
// TAMAMLANMAMIŞ olabilir (React/Angular gibi bir framework henüz mount olmamış / yönlendirme henüz
// gerçekleşmemiş) — performLogin() bu tür bir gecikmeyle AgentLoop'un LLM'i kendi kendine
// action="wait" seçerek BAŞA ÇIKABİLİYORDU (bkz. ilk login run kayıtlarındaki "step 0: wait"), ama
// scanPage() TEK SEFERLİK, LLM'siz bir tarama olduğu için böyle bir bekleme/tekrar mekanizması hiç
// YOKTU — sayfa henüz oturmadıysa direkt "0 element" ile başarısız oluyordu. Aşağıdaki değerler,
// sayfaya render/yönlendirme için birkaç kısa ek şans (artan gecikmelerle) tanır; İLK taramada
// zaten element bulunan (mevcut/çoğu) durumda HİÇBİR ek gecikme eklenmez, davranış ESKİSİ GİBİDİR.
const RESCAN_ON_EMPTY_DELAYS_MS = [1500, 2500];

// v3.40 — bkz. sohbet notu: performLogin() loop_detected analizi. Run kaydı incelendiğinde
// (suggest-login-nKH4R6cBbl.json) sorunun vector cache'le HİÇ ilgisi olmadığı kanıtlandı
// (disableVectorCache=true ile bile decisionSource HER adımda "llm" — yine de aynı hata). Gerçek
// sebep: kullanıcının login senaryosu metni ("...daha sonra açılan ekranda tüm işlemler kısmına
// gir ve açılan ekrandan senaryo üret") SADECE navigasyonu değil, bu AgentLoop'un YAPAMAYACAĞI bir
// görevi de ("senaryo üret" — bu, performLogin() bittikten SONRA scanPage() ile AYRI bir aşamada
// yapılıyor) tarif ediyor. Model bunu "iş bitmedi" diye yorumlayıp, zaten başarıyla tıklanmış
// (actionResult.ok=true) AYNI sekmeye ("Hepsi"/"Tüm İşlemler") tekrar tekrar tıklamayı deniyor —
// hiçbir zaman finish_success çağırmıyor. Bu talimat SADECE performLogin() çağrısına (bkz.
// PromptBuilder.buildSystemMessage / AgentLoopInput.extraSystemInstructions) ekleniyor; genel test
// koşumlarını (Generated Tests, generate-and-run) HİÇBİR ŞEKİLDE etkilemiyor.
// v3.43 — bkz. sohbet notu: v3.40'taki talimat "tarif edilen ekrana/duruma ulaştığında HEMEN
// finish_success seç" + "emin olamadığın durumlarda bile finish_success seçmek HER ZAMAN daha
// güvenlidir" ifadeleriyle ÇOK GEVŞEKTİ — kullanıcı "bu sefer senaryo üretti ama benim istediğim
// alandan değil, giriş yaptıktan sonra açılan ekrandan üretti" diye bildirdi: senaryo login DIŞINDA
// "tüm işlemler'e gir, ara, enter'a bas, radio butonuna tıkla" gibi BİRDEN FAZLA sıralı adım
// tarif ediyor, ama model muhtemelen login'den HEMEN SONRAKİ ilk ekranı "hedefe ulaşıldı" sayıp
// kalan adımları hiç DENEMEDEN erken bitiriyordu — v3.40'ın loop_detected'i önlemek için eklediği
// "emin olamadığında bile bitir" yönlendirmesi burada TERS etki yapmış (döngüyü önlerken bu SEFER
// erken bitirmeye YOL AÇMIŞ). Aşağıdaki metin bu ikisini AYRIŞTIRIYOR: "adımları sırayla EKSİKSİZ
// tamamla" kuralı ÖNCELİKLİ, "aynı aksiyonu sonsuz tekrarlama" kuralı SADECE gerçekten aynı
// aksiyon+hedef tekrar edilmek ÜZEREYKEN devreye giriyor (genel bir "emin değilsen bitir" izni
// ARTIK YOK).
const LOGIN_STEP_SYSTEM_INSTRUCTIONS = `EK KURAL — SADECE BU GÖREV İÇİN GEÇERLİ (giriş ön-adımı):
Yukarıdaki senaryo, SIRAYLA yapılması gereken BİRDEN FAZLA adım tarif ediyor (ör. giriş yap, SONRA bir
menüye/tab'a gir, SONRA ara, SONRA enter'a bas, SONRA bir seçenek işaretle). GÖREVİN, bu adımların
HEPSİNİ, tarif edildikleri SIRAYLA, TEK TEK gerçekleştirmek — sadece giriş yapıp durmak YETERLİ DEĞİLDİR.
Senaryo metninin sonunda "senaryo üret", "test oluştur", "öneri getir" gibi ifadeler geçebilir — SADECE
BUNLAR (browser'da yapılamayacak, senden SONRA başka bir süreçte gerçekleşecek adımlar) YOK SAYILIR;
senaryodaki GERİ KALAN TÜM adımlar (tıklama, yazma, arama, enter, seçim) GERÇEK, YAPILMASI GEREKEN
aksiyonlardır, atlanmaz.
SADECE şu durumda bir sonraki adıma geç (aynı aksiyonu TEKRARLAMA): geçmişte tam olarak AYNI aksiyon+
hedefi zaten "OK" sonuçla denediysen VE güncel element listesi bir önceki adımdan HİÇ FARKLI DEĞİLSE
(ör. "aria-selected":"true" ile zaten seçili görünen bir sekmeye TEKRAR tıklamak isteniyor) — bu durumda
o adımı TEKRARLAMADAN, senaryodaki BİR SONRAKİ adımın hedefini güncel element listesinde ara ve onu
gerçekleştir.
action="finish_success" SADECE şu ikisinden biri doğruysa seçilir: (1) senaryodaki YAPILABİLİR (browser
aksiyonu olan) TÜM adımlar başarıyla tamamlandıysa, VEYA (2) birkaç makul deneme/bekleme sonrasında bile
bir sonraki adımın hedef elementi sayfada HİÇBİR ŞEKİLDE bulunamıyorsa (bu durumda action="finish_failure"
kullanıp NEDENİNİ summary'ye yaz — sessizce erken bitirme). Sırf "muhtemelen buraya kadar yeterlidir" ya
da "emin değilim" gibi bir gerekçeyle, senaryoda tarif edilen SONRAKİ adımları hiç denemeden erken
action="finish_success" SEÇME — bu YANLIŞTIR.`;

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
   * @param login v3.3 — verilirse, `scanPage()`'den ÖNCE `performLogin()` ile kısa bir AI destekli
   *   giriş adımı çalıştırılır ve tarama, GİRİŞ YAPILMIŞ oturumla devam eder (bkz.
   *   ScenarioSuggestionLoginConfig). Verilmezse (varsayılan) davranış eskisi gibi — sayfa hiç
   *   giriş yapılmadan, anonim olarak taranır.
   */
  async suggest(
    url: string,
    headed = true,
    existingScenarios: string[] = [],
    focus = '',
    login?: ScenarioSuggestionLoginConfig,
  ): Promise<ScenarioSuggestion[]> {
    // history taraması login'e bağlı DEĞİLDİR (sadece geçmiş çalıştırılmış senaryoları okur) —
    // login adımının sıralı (ve yavaş) olmasından bağımsız olarak paralel başlatılır.
    const historyPromise = this.getRelevantHistory(url);

    // Login SIRALI olmak ZORUNDADIR: scanPage'in kullanacağı storageState/canlı sayfa, ancak login
    // BİTTİKTEN sonra bilinebilir (bkz. performLogin dosya başı açıklaması).
    const loginResult = login ? await this.performLogin({ ...login, url: login.url || url }, headed) : undefined;
    // v3.42 — bkz. performLogin()/scanPage() dosya başı NOT'ları: `browserManager` verildiyse
    // (normal/beklenen durum), scanPage() login'in ULAŞTIĞI CANLI sayfayı (arama/seçim durumu
    // dahil) kullanır — `url` bu durumda SADECE loglama/hata mesajları için taşınır, gerçek
    // taramada page.goto() ile ziyaret EDİLMEZ (bkz. scanPage() liveBrowser dalı).
    const { title, elements } = await this.scanPage(url, headed, loginResult?.storageState, loginResult?.browserManager);
    const history = await historyPromise;

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

  /**
   * v3.3 — Sayfa giriş gerektirdiğinde `suggest()` tarafından `scanPage()`'den ÖNCE çağrılır.
   * Gerçek test run'larında kullanılan AYNI AI karar motorunu (AgentLoop) — DomAnalyzer/
   * ActionExecutor/SecretsVault ile birlikte — kullanarak `login.scenario`'yu adım adım çalıştırır
   * (herhangi bir login formuna, çok adımlı akışa vb. uyum sağlayabilir; sabit selector'lara
   * dayanan kırılgan bir "otomatik doldurma" DEĞİLDİR). Giriş BAŞARILI olursa, context'in
   * çerez/localStorage durumunu (Playwright storageState) yakalayıp döner — bu, `scanPage()`'in
   * SIFIRDAN yeni bir tarayıcı context'ini bu durumla başlatıp taramayı GİRİŞ YAPILMIŞ haliyle
   * sürdürmesini sağlar.
   *
   * BİLİNÇLİ OLARAK bu AgentLoop run'ı runManager'a/persistan koşum geçmişine (Test Runs) HİÇ
   * kaydedilmez — kendi özel/yerel bir onEvent dinleyicisiyle, tamamen izole çalıştırılır (bkz.
   * types.ts'teki 'storage_state_captured' olayı dosya başı NOT'u: bu olay çerez taşıdığı için
   * ASLA genel bir WS yayın kanalına bağlanmamalıdır — burada da bağlanmıyor).
   *
   * Giriş adımı `passed` DIŞINDA bir durumla biterse (failed/error/cancelled), taramaya anonim
   * olarak SESSİZCE devam ETMEK yerine BİLEREK net bir hata fırlatılır — aksi halde kullanıcı,
   * aslında giriş yapılmamış bir sayfaya göre üretilmiş önerileri "giriş yapılmış" sanabilirdi.
   *
   * v3.42 — bkz. AgentLoopInput.handOffBrowserOnSuccess ve types.ts 'browser_handed_off' dosya
   * başı NOT'ları: dönüş değeri artık SADECE `storageState` değil, run PASSED ile bittiyse HALA
   * AÇIK olan `browserManager` referansını da içerebilir — `login.scenario` login DIŞINDA
   * navigasyon/arama/seçim adımları da tarif ediyorsa (ör. "...tüm işlemler kısmına gir, ara,
   * ... radio butonuna tıkla"), scanPage()'in bu CANLI sayfa üzerinden (page.goto() OLMADAN)
   * devam etmesi gerekir — aksi halde bu adımların ULAŞTIĞI DOM durumu (arama sonucu, seçili
   * radio vb.) kaybolur ve tarama YANLIŞLIKLA login sayfasının kendisine geri döner (bkz. sohbet
   * notu: "sadece login sayfası için senaryo üretiyor, istenilen sayfa için üretmiyor").
   */
  private async performLogin(
    login: ScenarioSuggestionLoginConfig & { url: string },
    headed: boolean,
  ): Promise<{ storageState?: StorageState; browserManager?: BrowserManager }> {
    const runId = `suggest-login-${nanoid(10)}`;
    let capturedState: StorageState | undefined;
    let handedOffBrowserManager: BrowserManager | undefined;

    const loop = new AgentLoop(this.llm, (event) => {
      if (event.type === 'storage_state_captured') {
        capturedState = event.storageState;
      } else if (event.type === 'browser_handed_off') {
        handedOffBrowserManager = event.browserManager;
      }
    });

    const options = {
      ...defaultRunOptions,
      headless: !headed,
      captureScreenshot: false,
      captureVideo: false,
      captureTrace: false,
      // v3.37 — bkz. MAX_ELEMENTS_IN_LOGIN_STEP dosya başı NOT'u.
      maxElementsPerStep: Math.min(defaultRunOptions.maxElementsPerStep, MAX_ELEMENTS_IN_LOGIN_STEP),
    };

    const report = await loop.run({
      runId,
      url: login.url,
      scenario: login.scenario,
      variables: login.variables ?? {},
      secrets: login.secrets ?? {},
      options,
      captureStorageState: true,
      // v3.38 — bkz. sohbet notu: "Login steps ve verileri değiştirmeme rağmen sanki işlemleri
      // cache'den okuyor" + loop_detected hatası. Bu, AgentLoopInput.disableVectorCacheRead dosya
      // başı NOT'unda (v3.24) zaten TANIMLANMIŞ ve /api/tests/generate-and-run için ÇÖZÜLMÜŞ olan
      // AYNI hata sınıfı: vector cache OKUMA tarafı (bkz. buildSituationText) senaryo METNİNİ
      // embedding'e dahil etse de, element YAPISI (tag/role/name) aynı kaldığı sürece (aynı giriş
      // sayfası) benzerlik çoğu zaman eşiği geçecek kadar yüksek kalıyor — bu da BAŞKA bir (eski/
      // farklı) login denemesinden kalma bir "click" kararının (fill/type değil — CACHE_HIT_SAFE_
      // ACTIONS'a bkz., ama "hangi butona tıkla" kararı fill DEĞİLDİR) LLM'e hiç danışılmadan
      // tekrar kullanılmasına yol açabiliyor. Kullanıcı Login Steps'i DEĞİŞTİRDİKÇE (tam olarak bu
      // sayfanın amacı) bu ESKİ kararlar YENİ senaryoyla uyuşmaz hale gelir — cache'ten gelen
      // "tıkla" kararı sayfanın durumunu ilerletmeyince LoopGuard birkaç adım sonra run'ı
      // loop_detected ile durdurur. performLogin() (generate-and-run'ın aksine) bu bayrağı ŞİMDİYE
      // KADAR hiç göndermiyordu — bu, tam olarak bu akış için gözden kaçmış bir eksiklikti. Login
      // ön-adımı zaten TEK seferlik/deneme-yanılma amaçlı, kısa bir akış olduğu için LLM'e her adım
      // danışmanın performans maliyeti ihmal edilebilir; doğruluk burada hıza HER ZAMAN tercih edilir.
      //
      // v3.39 — kullanıcı aynı loop_detected hatasını TEKRAR bildirdi ve açıkça "bu sayfada hiçbir
      // zaman vector db'ye gidilmesin" dedi. Yukarıdaki disableVectorCacheRead SADECE OKUMA
      // tarafını kapatıyordu — AgentLoop.run() içindeki YAZMA çağrısı (recordDecisionInCache) bu
      // bayrağı hiç kontrol etmiyordu, yani her başarılı adımdan sonra Milvus/Ollama'ya (embedding
      // için) hâlâ istek atılıyordu. Bu satır fiili loop_detected sebebi olmasa bile (yazma ateşle-
      // unut şeklinde ve aynı run içindeki kararları etkilemiyor), kullanıcının "asla vector db'ye
      // gitmesin" talimatını tam karşılamak için disableVectorCache (hem oku hem yaz, bkz.
      // AgentLoopInput tanımı) ile performLogin'i baştan sona vector cache'ten TAMAMEN izole
      // ediyoruz. disableVectorCacheRead de bilinçli olarak bırakıldı (geriye dönük/okunabilirlik).
      disableVectorCacheRead: true,
      disableVectorCache: true,
      // v3.40 — bkz. LOGIN_STEP_SYSTEM_INSTRUCTIONS dosya başı NOT'u.
      extraSystemInstructions: LOGIN_STEP_SYSTEM_INSTRUCTIONS,
      // v3.42 — bkz. performLogin() dosya başı NOT'u ve AgentLoopInput.handOffBrowserOnSuccess.
      handOffBrowserOnSuccess: true,
    });

    // v3.39 — RunLogger.persist() (AgentLoop.run() içinde, tüm çağıranlar için KOŞULSUZ) her zaman
    // RUNS_DIR/<runId>.json'a bir run detay dosyası yazar. Bu dosya login ön-adımı BİLEREK
    // TestRunStore'un index'ine hiç EKLENMEDİĞİ için "yetim" kalır ve index-tabanlı temizlik
    // araçlarınca silinemez — bu yüzden PASSED durumda hâlâ best-effort siliniyor. Ama FAILED
    // durumda (ör. loop_detected gibi teşhisi zor hatalarda) bu dosya, tam olarak hangi kararların/
    // adımların koşumu nereye kadar ilerlettiğini gösteren TEK kayıt — önceki bir olayda bu dosya
    // (suggest-login--whySAnKXp.json) hata raporlanana kadar zaten silinmiş olduğu için teşhis
    // imkânı kaybolmuştu. Bu yüzden artık sadece BAŞARILI koşumlarda siliniyor; başarısız koşumda
    // dosya diskte kalır (RUNS_DIR zaten periyodik/manuel "Delete Old Runs" ile temizlenebilir).
    if (report.status === 'passed') {
      await rm(path.join(path.resolve(env.RUNS_DIR), `${runId}.json`), { force: true }).catch((err) => {
        log.debug({ err, runId }, 'Login ön-adımının geçici run kaydı silinemedi (yok sayıldı)');
      });
    }

    if (report.status !== 'passed') {
      log.warn(
        { runId, status: report.status, failureReason: report.failureReason },
        'Senaryo önerisi login ön-adımı başarısız (teşhis için RUNS_DIR/' + runId + '.json korunuyor)',
      );
      throw new ValidationError(
        `Giriş adımı tamamlanamadı (${report.status}): ${report.failureReason ?? 'bilinmeyen hata'}. ` +
          'Giriş senaryosunu ve Değişkenler/Secrets değerlerini kontrol edip tekrar deneyin.',
      );
    }
    if (!capturedState && !handedOffBrowserManager) {
      throw new ValidationError('Giriş başarılı görünüyor ama oturum bilgisi yakalanamadı. Lütfen tekrar deneyin.');
    }
    // v3.42 — `handedOffBrowserManager` BEKLENEN (normal) sonuçtur: `handOffBrowserOnSuccess: true`
    // + report.status === 'passed' iken AgentLoop bunu HER ZAMAN devreder (bkz. AgentLoop.ts
    // finally bloğu). `capturedState` (SADECE çerezler) yine de döndürülür — SADECE devretme
    // beklenmedik şekilde gerçekleşmezse (ör. ileride bir kod değişikliğiyle bu davranış bozulursa)
    // scanPage()'in eskisi gibi storageState-temelli YEDEK yola düşebilmesi için.
    return { storageState: capturedState, browserManager: handedOffBrowserManager };
  }

  private async scanPage(
    url: string,
    headed: boolean,
    storageState?: StorageState,
    liveBrowser?: BrowserManager,
  ): Promise<{ title: string; elements: DiscoveredElement[] }> {
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

    // v3.42 — bkz. performLogin() ve AgentLoopInput.handOffBrowserOnSuccess dosya başı NOT'ları:
    // login senaryosu login DIŞINDA navigasyon/arama/seçim adımları da içerdiğinde (ör. "...tüm
    // işlemler kısmına gir, ara, ... radio butonuna tıkla"), bu adımların ULAŞTIĞI CANLI DOM
    // durumu SADECE bu hala açık olan sayfada var — storageState (çerezler) bunu TAŞIMAZ. Bu
    // yüzden `liveBrowser` verildiğinde YENİ bir tarayıcı/sayfa AÇILMAZ ve `page.goto()` HİÇ
    // ÇAĞRILMAZ — doğrudan performLogin()'in bıraktığı sayfa üzerinden taranır, böylece arama
    // kutusuna yazılan metin, tıklanan radio buton vb. TÜM durum KORUNUR. `browserManager.close()`
    // sorumluluğu da BURAYA (asıl sahibi artık burası) geçmiştir.
    if (liveBrowser) {
      try {
        const page = liveBrowser.getPage();
        await dismissConsentBanners(page);
        let { snapshot } = await domAnalyzer.analyze(page, options);

        // v3.41 — bkz. RESCAN_ON_EMPTY_DELAYS_MS dosya başı NOT'u.
        for (const waitMs of RESCAN_ON_EMPTY_DELAYS_MS) {
          if (snapshot.elements.length > 0) break;
          log.debug({ url, waitMs }, 'İlk taramada hiç element bulunamadı, sayfanın oturması beklenip tekrar deneniyor');
          await page.waitForTimeout(waitMs);
          await dismissConsentBanners(page);
          ({ snapshot } = await domAnalyzer.analyze(page, options));
        }

        return { title: snapshot.title, elements: snapshot.elements };
      } catch (err) {
        log.warn({ err, url }, 'Devralınan canlı sayfa taranamadı (senaryo önerisi için)');
        throw new ValidationError('Sayfa taranamadı. Login senaryosunu ve URL\'yi kontrol edip tekrar deneyin.');
      } finally {
        await liveBrowser.close();
      }
    }

    const browserManager = new BrowserManager();
    try {
      const page = await browserManager.launch(options, undefined, storageState, url);
      try {
        await page.goto(url, { timeout: options.navigationTimeoutMs, waitUntil: 'domcontentloaded' });
        await dismissConsentBanners(page);
        let { snapshot } = await domAnalyzer.analyze(page, options);

        // v3.41 — bkz. RESCAN_ON_EMPTY_DELAYS_MS dosya başı NOT'u: ilk taramada hiç element
        // bulunamazsa (ör. login sonrası SPA yönlendirmesi/render'ı henüz tamamlanmamış olabilir),
        // vazgeçmeden önce sayfanın oturması için birkaç kısa ek şans tanınır.
        for (const waitMs of RESCAN_ON_EMPTY_DELAYS_MS) {
          if (snapshot.elements.length > 0) break;
          log.debug({ url, waitMs }, 'İlk taramada hiç element bulunamadı, sayfanın oturması beklenip tekrar deneniyor');
          await page.waitForTimeout(waitMs);
          await dismissConsentBanners(page);
          ({ snapshot } = await domAnalyzer.analyze(page, options));
        }

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
