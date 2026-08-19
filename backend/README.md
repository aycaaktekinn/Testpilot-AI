# AI Playwright Automation — Backend

Doğal dilde yazılmış web test senaryolarını, yapay zekâ (LLM) ve Playwright kullanarak otomatik
olarak çalıştıran **generic** bir web test otomasyon backend'i. Herhangi bir siteye özel değildir;
e-ticaret, admin panel, CRM, SaaS ya da kurumsal herhangi bir web uygulamasında kullanılabilir.

Sistem senaryodan **önceden statik bir Playwright script'i üretip onu çalıştırmaz**. Bunun yerine,
her adımda sayfanın o anki canlı DOM'unu tarar, bir LLM'e "sayfada şunlar var, senaryo bunu
istiyor, sıradaki tek aksiyon ne olmalı?" diye sorar, dönen kararı doğrulayıp güvenli şekilde
uygular ve sonucu tekrar gözlemleyerek devam eder. Bu sayede sayfa küçük değişikliklere uğrasa
(buton yeri değişse, beklenmeyen bir çerez/onay pop-up'ı çıksa) bile esnek kalır.

## İçindekiler

- [Mimari genel bakış](#mimari-genel-bakış)
- [Katmanlar ve sorumluluklar](#katmanlar-ve-sorumluluklar)
- [Ajan döngüsü (agent loop) nasıl çalışır](#ajan-döngüsü-agent-loop-nasıl-çalışır)
- [Güvenlik tasarımı](#güvenlik-tasarımı)
- [Dayanıklılık / kendi kendini toparlama](#dayanıklılık--kendi-kendini-toparlama)
- [Kurulum](#kurulum)
- [Ortam değişkenleri](#ortam-değişkenleri)
- [API](#api)
- [Mevcut frontend uyum katmanı (legacy adapter)](#mevcut-frontend-uyum-katmanı-legacy-adapter)
- [Senaryo önerisi (AI destekli)](#senaryo-önerisi-ai-destekli)
- [Allure raporlama](#allure-raporlama)
- [Örnek istek](#örnek-istek)
- [Test](#test)
- [Sorun giderme](#sorun-giderme)
- [Bilinen sınırlamalar / sonraki adımlar](#bilinen-sınırlamalar--sonraki-adımlar)

## Mimari genel bakış

```
Kullanıcı (frontend)
   │  POST /api/runs { url, scenario, variables, secrets }
   ▼
RunManager  ──►  AgentLoop  ──►  DomAnalyzer  ──►  Playwright (gerçek tarayıcı)
                     │               │
                     │               └─► sayfanın canlı, etkileşilebilir elementleri
                     │
                     ├─► PromptBuilder ──► LlmProvider (OpenRouter / Gemini) ──► ResponseParser
                     │        (bir sonraki aksiyonu seçer)
                     │
                     ├─► LoopGuard (sonsuz döngü / tekrar koruması)
                     ├─► SecretsVault (secret/variable maskeleme + resolve)
                     ├─► ActionExecutor (Playwright'a güvenli uygulama + otomatik toparlanma)
                     └─► RunLogger (JSON adım logları + PASS/FAIL raporu)
                     │
                     ▼
             WebSocket /ws/runs/:id  ──► canlı ilerleme akışı
```

Aynı `AgentLoop` iki farklı API yüzeyinden kullanılır: yeni, generic `/api/runs` (çoklu run,
runId+WebSocket tabanlı) ve mevcut frontend'in beklediği eski `/api/tests/...` sözleşmesi
(`LegacyTestService` üzerinden — bkz. [Mevcut frontend uyum katmanı](#mevcut-frontend-uyum-katmanı-legacy-adapter)).

Akış, "algıla → karar ver → uygula → tekrar algıla" (perceive → decide → act → re-perceive)
döngüsü şeklinde çalışır ve senaryo tamamlanana ya da güvenli bir şekilde durana kadar devam eder.

## Katmanlar ve sorumluluklar

| Katman | Klasör | Sorumluluk |
|---|---|---|
| Domain | `src/domain` | Sitelerden/uygulamalardan bağımsız çekirdek tipler, hatalar, istek şeması |
| Config | `src/config` | Ortam değişkenleri (zod ile doğrulanır), logger |
| Browser | `src/core/browser` | Playwright browser/context/page yaşam döngüsü, çerez/onay banner'ı ve engelleyici overlay kurtarma |
| DOM | `src/core/dom` | Canlı DOM keşfi (iframe + açık Shadow DOM dahil), element referanslama |
| Actions | `src/core/actions` | LLM kararının zod ile doğrulanması + Playwright üzerinde güvenli uygulanması |
| LLM | `src/core/llm` | Provider-agnostic LLM arayüzü, OpenRouter + Gemini implementasyonları, prompt/response yönetimi |
| Agent | `src/core/agent` | Ana ajan döngüsü, döngü/tekrar koruması (LoopGuard) |
| Secrets | `src/core/secrets` | Variable/secret yönetimi, maskeleme, redaksiyon |
| Logging | `src/core/logging` | Adım adım JSON log + PASS/FAIL raporu |
| Scenario | `src/core/scenario` | Bir URL'yi ziyaret edip AI destekli senaryo önerileri çıkaran `ScenarioSuggester` |
| Legacy | `src/core/legacy` | Mevcut frontend'in eski API sözleşmesine uyum katmanı (kod sentezleme, koşum/dosya geçmişi, Allure raporu) |
| API | `src/api` | REST + WebSocket dış dünya arayüzü |

Her katman yalnızca kendi sorumluluğuna bakar ve somut sınıflar yerine arayüzlere bağımlıdır
(örn. `LlmProvider` arayüzü sayesinde OpenRouter yerine başka bir sağlayıcı eklemek tek bir yeni
sınıf yazmaktan ibarettir — bkz. `src/core/llm/createLlmProvider.ts`).

## Ajan döngüsü (agent loop) nasıl çalışır

Her adımda (`AgentLoop.run` içindeki `for` döngüsü):

1. **DOM analizi** — `DomAnalyzer`, sayfanın (ana frame + tüm iframe'ler + açık Shadow DOM)
   canlı DOM'unu tarar, görünür ve etkileşilebilir elementleri bulur, her birine `e1`, `e2`, ...
   gibi kararlı, geçici bir referans atar (`data-ai-ref` attribute'u ile).
2. **Prompt oluşturma** — `PromptBuilder`, senaryo, geçmiş aksiyonlar özeti ve güncel element
   listesini LLM'e gönderilecek prompt'a dönüştürür. **Ham CSS selector/XPath asla LLM'e gösterilmez**,
   sadece `eN` referansları gösterilir.
3. **LLM çağrısı** — `LlmProvider.complete(...)` çağrılır, dönen metin `ResponseParser` ile JSON
   olarak parse edilip zod şemasına (`agentDecisionSchema`) göre doğrulanır. Geçersizse en fazla
   2 kez otomatik yeniden denenir (gereksiz tekrar LLM çağrısını önlemek için sınırlıdır).
4. **Güvenlik kapıları** (aşağıya bakınız) — düşük güven, bilinmeyen secret/variable referansı,
   veya döngü tespiti varsa run güvenli şekilde `failed`/`error` ile sonlandırılır. Ayrıca kullanıcı
   "Stop" derse (`AgentLoop.cancel()`), bu kontrol LLM çağrısı sürerken bile en kısa sürede fark
   edilip run `cancelled` ile hemen sonlandırılır — yavaş bir aksiyonun bitmesi beklenmez.
5. **Uygulama** — `ActionExecutor`, kararı gerçek Playwright API çağrılarına çevirir (yalnızca
   bu adımda keşfedilen `eN` referanslarına izin verilir; halüsinasyon element'e asla dokunulmaz).
6. **Loglama + yayın** — adım `RunLogger`'a yazılır ve varsa WebSocket abonelerine `step` olayı
   olarak yayınlanır.
7. Model `finish_success` derse run `passed`, `finish_failure`/`ask_clarification` derse run
   `failed` olarak sonlanır. `AGENT_MAX_STEPS` aşılırsa run `failed` (`max_steps_reached`) olur.

## Güvenlik tasarımı

Görev tanımındaki tüm güvenlik gereksinimleri şu şekilde karşılanır:

- **Belirsizlikte güvenli durma**: LLM'in `confidence` değeri `AGENT_MIN_CONFIDENCE` altındaysa
  ya da model kendisi `ask_clarification` derse, run **hiçbir aksiyon uygulamadan** `failed`
  olarak durur (`ambiguous_step` nedeniyle). Yanlış elemente tıklamaktansa durmak tercih edilir —
  bu davranış bir hata değil, bilinçli bir tasarım kararıdır.
- **Halüsinasyon koruması**: `ActionExecutor`, sadece o adımda `DomAnalyzer`'ın gerçekten
  bulduğu `eN` referanslarını kabul eder (`agentDecisionSchema` regex ile `^e\d+$` formatını,
  `ElementHandleRef` registry'si ise referansın o an var olup olmadığını doğrular).
- **Sonsuz döngü / gereksiz tekrar koruması**: `LoopGuard`, aynı (aksiyon+hedef+değer) imzasının,
  sayfa durumu (`stateHash`) hiç değişmeden `AGENT_MAX_REPEATED_ACTIONS` kez tekrarlanmasını
  tespit eder ve run'ı güvenli şekilde durdurur. Ayrıca mutlak bir `AGENT_MAX_STEPS` sınırı vardır.
- **Secret güvenliği**: Secret DEĞERLERİ hiçbir zaman LLM prompt'una gönderilmez — LLM'e sadece
  secret **adları** gösterilir, model `{{secret.AD}}` placeholder'ı üretir. Gerçek değer sadece
  `ActionExecutor`'a hemen önce, bellekte çözülür (`SecretsVault.resolve`). Loglara yazılan her
  şey (`reasoning`, `value`, hata mesajları) `SecretsVault.maskForLog` / `redactSecretValuesFromText`
  ile maskelenir — hem placeholder maskesi hem de olası ham değer sızıntısına karşı ikinci bir
  metin taraması uygulanır.
- **JS dialog güvenliği**: `alert`/`confirm`/`prompt` gibi beklenmeyen dialog'lar otomatik ve
  güvenli şekilde kapatılır (akışın kilitlenmemesi için).
- **Zaman aşımları**: Her aksiyonun kendi Playwright timeout'u vardır; ayrıca adım başına genel
  bir `AGENT_STEP_TIMEOUT_MS` güvenlik ağı bulunur. Bir aksiyon, engelleyici bir overlay'i
  kurtarma denemesinden sonra tekrar denendiğinde bile, toplam adım süresi bu güvenlik ağını
  aşamayacak şekilde ayrıca sınırlanır (bkz. aşağıdaki dayanıklılık bölümü).
- **Gereksiz LLM çağrısı azaltma**: Prompt'taki element listesi `AGENT_MAX_ELEMENTS_PER_STEP` ile
  sınırlanır, geçmiş (history) son 12 adımla sınırlı tutulur, ve geçersiz JSON yanıtlarında
  sınırsız değil en fazla 2 ek deneme yapılır.

## Dayanıklılık / kendi kendini toparlama

Gerçek sitelerle (özellikle büyük e-ticaret siteleriyle) yapılan test koşumlarında gözlemlenen
somut sorunlara karşı, ajan döngüsü şu otomatik toparlanma mekanizmalarını içerir:

- **Çerez/onay banner'ı yarış durumu**: Bir banner, adımın DOM taramasından SONRA ama aksiyon
  gerçekten uygulanmadan ÖNCE ortaya çıkabilir. `dismissConsentBanners()` hem her adımın
  başında hem de bir aksiyon engellenip kurtarma denemesi yapılmadan hemen önce tekrar çağrılır.
- **Engelleyici (intercepting) overlay kurtarma**: Bir tıklama "element başka bir şey tarafından
  engelleniyor" hatasıyla başarısız olursa, `InterceptingOverlayHandler` önce overlay'i kapatmayı
  dener (Escape, kapatma butonu vb.). Kapatılamayan **kalıcı** bir engelleyici (ör. sayfaya
  yapışık bir "Sepete Ekle" çubuğu) tespit edilirse — hedef elementin gerçekten doğru element
  olduğu `document.elementFromPoint` ile önceden doğrulandığı için güvenli kabul edilip —
  Playwright'ın `force: true` seçeneğiyle tek seferlik bir yeniden deneme yapılır.
- **Zaman aşımı bütçesi**: Yukarıdaki yeniden deneme, orijinal aksiyonun tüm timeout'unu değil,
  sabit ve düşük bir üst sınırı (3 saniye) kullanır — böylece toplam adım süresi asla
  `AGENT_STEP_TIMEOUT_MS` güvenlik ağını aşmaz.
- **Arama/Enter sonrası yerleşme payı**: Kullanıcı bir arama kutusuna yazıp Enter'a bastığında,
  sayfa URL'si hemen değişmese bile (SPA içi, gecikmeli sonuç yüklemesi) sonraki DOM taramasından
  önce kısa bir bekleme uygulanır — böylece agent, henüz yüklenmekte olan sonuçlar yerine güncel
  DOM'u görür.

Bu mekanizmaların hiçbiri PASS/FAIL sonucunu manipüle etmez; sadece geçici/kozmetik engelleri
aşıp ajanın senaryoya asıl konsantre olmasını sağlar. Gerçek bir belirsizlik durumunda (ör. bir
filtre alanının etiket mi giriş alanı mı olduğu net değilse) ajan yine de [güvenli şekilde
durur](#güvenlik-tasarımı) — bu toparlanma mekanizmaları asla "tahmin et" davranışına dönüşmez.

## Kurulum

> Bu proje **Node.js 18.18+** ve Playwright gerektirir.

```bash
cd backend
cp .env.example .env
# .env içine OPENROUTER_API_KEY değerinizi girin (https://openrouter.ai üzerinden alınır)

npm install
npm run playwright:install   # Chromium + Firefox + WebKit indirir

npm run dev                  # geliştirme (tsx watch)
# veya
npm run build && npm start   # production
```

Sunucu ayağa kalktıktan sonra tarayıcıda **`http://localhost:4000/`** adresini açın — backend,
`frontend/` klasörünü aynı origin'den sunar, bu yüzden ayrı bir statik sunucu kurmanıza gerek yoktur.

## Ortam değişkenleri

Tüm değişkenler `.env.example` içinde açıklamalarıyla birlikte listelenmiştir; `src/config/env.ts`
bunları zod ile doğrular ve uygulama, eksik/geçersiz bir değişken varsa **başlangıçta net bir hata
ile durur** (sessizce yanlış davranmaz).

Öne çıkanlar:

- `LLM_PROVIDER` — `openrouter` (varsayılan) ya da `gemini`. Seçilen sağlayıcının API anahtarı
  zorunludur, diğeri boş bırakılabilir (`src/config/env.ts` bunu başlangıçta doğrular).
  - `openrouter`: `OPENROUTER_API_KEY` zorunlu. `OPENROUTER_MODEL` varsayılan olarak ücretsiz bir
    modele (`meta-llama/llama-3.3-70b-instruct:free`) ayarlıdır; genel amaçlı, "reasoning"
    özelliği kapalı bir instruct modeli tercih edin (bazı ücretsiz/"reasoning" modeller kararsız
    davranabiliyor — bkz. Sorun giderme). Bütçeniz varsa OpenRouter üzerinden daha güçlü/kararlı
    bir model de seçebilirsiniz — ör. `OPENROUTER_MODEL=anthropic/claude-sonnet-5`.
  - `gemini`: `GEMINI_API_KEY` zorunlu, [aistudio.google.com](https://aistudio.google.com/apikey)
    üzerinden alınır. Google'ın kendi altyapısında çalıştığı için OpenRouter'daki topluluk
    modellerine göre genelde daha kararlı/hızlı yanıt verir. `GEMINI_MODEL` için **bilinçli olarak
    kodda hardcoded bir varsayılan yoktur** — Google, ücretsiz/kullanılabilir model adlarını zaman
    zaman değiştiriyor. Bu yüzden `.env`'de açıkça doldurulması zorunludur (bkz. `.env.example`'daki
    güncel modelleri listelemek için kullanabileceğiniz `curl` komutu). Yanlış/kullanılamayan bir
    model girilirse, `GeminiProvider.validateConfig()` bunu herhangi bir test adımı (ve
    Playwright/tarayıcı) başlamadan önce, açık ve retry edilmeyen bir yapılandırma hatasıyla bildirir.
- `AGENT_MAX_STEPS`, `AGENT_MAX_REPEATED_ACTIONS`, `AGENT_MIN_CONFIDENCE` — güvenlik limitleri.
- `AGENT_LLM_TIMEOUT_MS` — LLM isteği bu süreden uzun sürerse iptal edilip adım yeniden denenir
  (ücretsiz modeller yoğun saatlerde yavaş olabildiği için varsayılan bilinçli olarak yüksektir).
- `PLAYWRIGHT_HEADLESS` — `false` yapılırsa tarayıcı görünür şekilde açılır (debug için kullanışlı).
  Bazı siteler (ör. hepsiburada.com) headless tarayıcıyı bot koruması ile tespit edip boş sayfa
  döndürebiliyor; bu yüzden hem "Headed mode" checkbox'ı hem de senaryo önerisi taraması varsayılan
  olarak açık (headed) çalışır.
- `RUNS_DIR` — adım adım JSON loglarının ve PASS/FAIL raporlarının yazılacağı klasör.
- `ARTIFACTS_DIR` — ekran görüntüsü/video/trace dosyalarının yazılacağı klasör (`/artifacts` altında sunulur).
- `GENERATED_TESTS_DIR` — legacy uyum katmanının sentezlediği `.spec.ts` dosyalarının klasörü.
- `ALLURE_RESULTS_DIR` / `ALLURE_REPORT_DIR` — Allure rapor entegrasyonu için (bkz. [Allure raporlama](#allure-raporlama)).
- `FRONTEND_DIR` — statik frontend dosyalarının klasörü (varsayılan `../frontend`); backend bunu
  aynı origin'den sunar, `http://localhost:<PORT>/` adresinde açılır.

## API

| Method | Endpoint | Açıklama |
|---|---|---|
| `POST` | `/api/runs` | Yeni bir test run'ı başlatır, hemen `202` ile `RunSummary` döner |
| `GET` | `/api/runs/:id` | Run'ın güncel durumunu döner (`pending/running/passed/failed/error/cancelled`) |
| `GET` | `/api/runs/:id/report` | Run tamamlandıysa tüm adımları + PASS/FAIL sonucunu döner |
| `POST` | `/api/runs/:id/cancel` | Devam eden bir run'ı iptal eder |
| `GET` | `/api/health` | Sağlık kontrolü |
| `GET` | `/api/settings` | Salt-okunur LLM/agent/Playwright yapılandırma özeti (API anahtarı maskelenmiş) |
| `POST` | `/api/scenarios/suggest` | Bir URL'yi ziyaret edip AI destekli senaryo önerileri döner |
| `GET` | `/api/allure/status` | Daha önce üretilmiş bir Allure raporu var mı |
| `POST` | `/api/allure/generate` | Kayıtlı koşum sonuçlarından statik bir Allure HTML raporu üretir |
| `WS` | `/ws/runs/:id` | Canlı ilerleme akışı (`run_started`, `step`, `run_finished`, `run_error`) |

Ayrıca mevcut frontend'in kullandığı `/api/tests/...` ve `/api/test-runs`, `/api/generated-tests...`
uç noktaları vardır — bkz. [Mevcut frontend uyum katmanı](#mevcut-frontend-uyum-katmanı-legacy-adapter).

### `POST /api/runs` istek gövdesi

```jsonc
{
  "url": "https://example.com/login",
  "scenario": "Kullanıcı adı ve şifre ile giriş yap, ardından 'Hoş geldin' mesajının göründüğünü doğrula.",
  "variables": { "kullaniciAdi": "test.kullanici" },
  "secrets": { "PASSWORD": "gercek-sifre-buraya" },
  "options": { "maxSteps": 25, "headless": true }
}
```

Senaryo metninde ya da variables/secrets içinde herhangi bir CSS selector, XPath veya koordinat
belirtmenize **gerek yoktur** — sistem bunları kendisi keşfeder.

## Mevcut frontend uyum katmanı (legacy adapter)

`frontend/` klasöründeki mevcut arayüz, farklı (ve daha eski) bir API sözleşmesi bekleyecek şekilde
yazılmıştı: senaryodan statik bir Playwright dosyası "üretip" onu çalıştıran, tek seferlik/bloklayan
bir model. Frontend'e **hiç dokunulmadı** (yalnızca birkaç bilinen kullanıcı deneyimi sorunu için —
Stop butonu ve artifact indirme — hedefli, dar kapsamlı düzeltmeler yapıldı, bkz. `frontend/README.md`)
— asıl uyum, `src/core/legacy/` altındaki bir katmanla sağlanır ve bu katman, gerçek çalıştırmayı
hep aynı canlı-DOM-ajanı mimarisiyle yapıp sonucu frontend'in beklediği şekle çevirir.

| Method | Endpoint | Frontend akışı |
|---|---|---|
| `POST` | `/api/tests/generate-and-run` | Create Test sayfası — "Generate & Run Test" |
| `GET` | `/api/tests/current-run-id` | O an aktif bir run varsa runId'sini döner (canlı log bağlantısı için) |
| `POST` | `/api/tests/stop` | Create Test sayfası — "Stop Test" (o an aktif olan tek run'ı iptal eder) |
| `GET` | `/api/test-runs` | Test Runs, Reports, Dashboard sayfaları — koşum geçmişi |
| `GET` | `/api/generated-tests` | Generated Tests, Dashboard sayfaları — üretilen dosya listesi |
| `GET` | `/api/generated-tests/:fileName` | "View Code" — üretilen dosyanın içeriği |
| `DELETE` | `/api/generated-tests/:fileName` | Tek bir üretilmiş dosyayı siler |
| `DELETE` | `/api/generated-tests` | Tüm üretilmiş dosyaları temizler |
| `POST` | `/api/generated-tests/run` | "Run" — daha önce üretilmiş bir testi tekrar çalıştırır |

Önemli noktalar:

- **"Generated code" gerçek değildir, sentezdir.** Sistem hâlâ senaryodan önceden statik kod üretip
  onu çalıştırmıyor; ajan canlı DOM'a göre adım adım karar veriyor. Her run bittikten sonra,
  `src/core/legacy/codeSynthesizer.ts` ajanın attığı adımlardan, **sadece gerçek Playwright aksiyon
  satırlarından oluşan** (hiçbir yorum/açıklama satırı olmadan — bu bilinçli bir tasarım tercihidir)
  bir kod özeti üretir ve bunu `GENERATED_TESTS_DIR` altına gerçek bir `.spec.ts` dosyası olarak
  kaydeder. Terminal kararlar (`finish_success`/`finish_failure`/`ask_clarification`) gerçek bir
  Playwright çağrısına karşılık gelmediği için hiç satır üretmez.
- **"Run" yeniden-üretim değil, yeniden-çalıştırmadır.** Bir `.spec.ts` dosyasını "Run" ile tekrar
  çalıştırdığınızda, o statik metin çalıştırılmaz; kaydedilen orijinal `url`/`scenario`/`variables`
  bilgisiyle ajan yeniden, sayfanın O ANKİ güncel DOM'una göre çalışır.
- **Tek aktif run modeli.** Frontend aynı anda birden fazla koşumu takip etmediği (runId kavramı
  yok) için bu katman da tek bir "aktif run" tutar; `/api/tests/stop` bunu iptal eder. İptal isteği,
  o an süren bir LLM çağrısı bitmeden bile fark edilip run en kısa sürede `cancelled` olarak sonlanır.
- **Tarayıcı seçimi + screenshot/video/trace.** Frontend'deki `browser` (chromium/firefox/webkit),
  `screenshot`, `video`, `trace` seçenekleri gerçekten uygulanır (`BrowserManager` ilgili motoru
  başlatır, Playwright'ın `recordVideo` ve `tracing` API'lerini kullanır). Üretilen dosyalar
  `ARTIFACTS_DIR` altına yazılır ve `/artifacts/<runId>/...` üzerinden statik olarak sunulur.
  Bu yakalamalar **en iyi çaba (best-effort)** prensibiyle çalışır: başarısız olsalar bile run'ın
  PASS/FAIL sonucunu asla etkilemezler.
- **Kalıcı geçmiş.** `TestRunStore` (`RUNS_DIR/test-runs-index.json`) ve `GeneratedTestStore`
  (`GENERATED_TESTS_DIR/index.json`) dosya tabanlı, append-only kayıtlardır — sunucu yeniden
  başlasa bile Test Runs / Reports / Dashboard sayfaları geçmişi göstermeye devam eder.
- **Hata sözleşmesi.** Frontend bazı endpoint'lerde (`/generated-tests/run`) HTTP durum kodunu hiç
  kontrol etmiyor; bu yüzden bu endpoint'ler iş mantığı hatalarında bile her zaman `200` ve
  frontend'in beklediği tam gövde şeklini (`status:'failed'`, dolu `message`) döner. Gerçek
  doğrulama/sistem hataları düz `{ message }` gövdesiyle uygun HTTP durum koduyla döner.

## Senaryo önerisi (AI destekli)

`ScenarioSuggester` (`src/core/scenario/ScenarioSuggester.ts`), verilen bir URL'yi **gerçekten**
(tek seferlik, hiçbir aksiyon almadan) ziyaret edip sayfanın yapısını çıkarır, aynı sitede daha
önce çalıştırılmış senaryoları (varsa, geçmiş PASS/FAIL durumlarıyla) okur, ardından LLM'den bu
bağlama göre çeşitlendirilmiş, gerçekçi senaryo önerileri ister (`POST /api/scenarios/suggest`).

- Öneriler **sadece sayfada gerçekten var olan elementlere** dayanır — uydurma özellik önerilmez.
- Sayfada birden fazla işlevsel alan varsa (ör. hem giriş formu hem ürün arama), her biri için
  ayrı, odaklı bir senaryo önerilir; tek bir dev senaryoda birleştirilmez.
- Metin girişi olan sayfalarda önerilerden en az biri bir negatif/uç durum (edge case) testi olur.
- Giriş/şifre gerektiren senaryolarda gerçek değer yazılmaz, `{{var.EMAIL}}` / `{{secret.PASSWORD}}`
  gibi placeholder'lar kullanılır.
- **"Get More Suggestions" akışı**: frontend, kullanıcıya o oturumda zaten gösterilmiş senaryo
  metinlerini isteğe `existingScenarios` alanıyla ekleyerek geri gönderebilir — bu durumda LLM'e,
  bunların hiçbirini tekrarlamaması, tamamen yeni senaryolar üretmesi talimatı verilir. Böylece
  kullanıcı tek bir sabit öneri kümesiyle sınırlı kalmaz.

## Allure raporlama

Her run tamamlandığında (legacy adaptör üzerinden), `AllureReportService` sonucu `ALLURE_RESULTS_DIR`
altına Allure'ın beklediği `*-result.json` formatında yazar (best-effort — bu asla run'ın PASS/FAIL
sonucunu etkilemez). Reports sayfasındaki "Generate Report" butonu, `POST /api/allure/generate` ile
bu sonuçlardan statik bir HTML raporu üretir (`allure` npm paketi, ekstra bir kurulum gerekmez) ve
`ALLURE_REPORT_DIR` altına yazar; bu klasör `/allure-report` altında sunulur.

## Örnek istek

```bash
curl -X POST http://localhost:4000/api/runs \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "scenario": "Arama kutusuna \"playwright\" yaz ve ara butonuna tıkla, sonuç sayfasının yüklendiğini doğrula."
  }'
```

Dönen `runId` ile ilerlemeyi takip edin:

```bash
curl http://localhost:4000/api/runs/<runId>
curl http://localhost:4000/api/runs/<runId>/report
```

ya da canlı akış için: `ws://localhost:4000/ws/runs/<runId>`

## Test

```bash
npm test
```

`tests/` klasöründeki birim testleri, çekirdek güvenlik/doğruluk davranışlarının yanı sıra üretilen
her düzeltmenin regresyona uğramadığını doğrular: `SecretsVault` (secret sızdırmama), `LoopGuard`
(döngü tespiti), `agentDecisionSchema`/`ResponseParser` (LLM çıktı doğrulama ve halüsinasyon
koruması), `ActionExecutor` (overlay kurtarma, zaman aşımı bütçesi, çerez banner'ı yarış durumu),
`AgentLoop` (Stop/iptal davranışı, Enter sonrası yerleşme payı), `codeSynthesizer` (sıfır yorum
satırı garantisi), `ScenarioSuggester` ("Get More Suggestions" tekrarsızlık talimatı) ve diğerleri.

## Sorun giderme

- **Test/run "takılı" görünüyor (siteyi açıyor ama sonra hiçbir şey olmuyor):** Bu genellikle
  ücretsiz OpenRouter modelinin yoğun saatlerde çok yavaş yanıt vermesi/kuyruğa alınmasından
  kaynaklanır. `OpenRouterProvider`, isteği en fazla `AGENT_LLM_TIMEOUT_MS` (varsayılan 45000ms)
  kadar bekler; bu süre dolunca istek iptal edilir, adım hata olarak işaretlenip otomatik olarak
  yeniden denenir (`AgentLoop` içinde en fazla 2 kez). Bir adım tüm denemelerde başarısız olursa
  run, sonsuza dek beklemek yerine düzgün bir hata mesajıyla `error` durumunda sonlanır. Çözüm
  önerileri: `.env` içinde `AGENT_LLM_TIMEOUT_MS` değerini yükseltin, daha basit/az elementli bir
  site ile test edin (örn. `https://example.com`), OpenRouter'da farklı bir model deneyin, ya da
  ücretli/daha kararlı bir model kullanın (ör. `anthropic/claude-sonnet-5`).
- **"OpenRouter/Gemini yanıtında içerik bulunamadı":** Model, ayırdığı token bütçesini görünmez bir
  "iç düşünce" (reasoning/thinking) sürecine harcayıp asıl cevabı boş bırakmış olabilir
  (`finish_reason=length` / `MAX_TOKENS`). Kod bunu tespit edip otomatik olarak daha yüksek bir
  bütçeyle bir kez daha dener; yine de başarısız olursa loglarda ham yanıtı (`rawResponse`)
  görebilirsiniz. Kalıcı çözüm: `LLM_PROVIDER=gemini`'ye geçmek ya da OpenRouter'da genel amaçlı,
  "reasoning" özelliği kapalı bir instruct modeli kullanmaktır.
- **"GEMINI_MODEL=... bulunamadı/kullanılamıyor (404)":** Google, ücretsiz katmandaki model
  adlarını zaman zaman değiştiriyor/kullanımdan kaldırıyor. Bu, RETRY EDİLEMEYEN bir yapılandırma
  hatası olarak sınıflandırılır: `AgentLoop`, `GeminiProvider.validateConfig()` aracılığıyla bunu
  Playwright/tarayıcıyı hiç başlatmadan önce kontrol eder ve tespit ederse hiçbir test adımı
  çalıştırmadan, run'ı `error` durumunda ve `configuration_error: ...` önekiyle anında sonlandırır.
  Çözüm: `.env.example`'daki `curl` komutuyla güncel bir model adı bulup `GEMINI_MODEL`'i güncelleyin.
- **Belirli bir sitede sürekli hata/başarısız oluyor / "güven eşiğinin altında durdu":** Bazı
  siteler (özellikle büyük e-ticaret siteleri) bot koruması, çerez onay pop-up'ları ya da çok
  yoğun/karmaşık filtre panelleri içerebilir; bu durumda ajan hedef elementi net biçimde ayırt
  edemeyip **bilinçli olarak** güvenli şekilde durabilir (bkz. [Güvenlik tasarımı](#güvenlik-tasarımı)).
  Bu bir hata değildir. Senaryoyu, belirsizliğe yol açan adımı daha açık anlatacak şekilde
  (ör. "önce X alanına tıkla, odaklandıktan sonra Y değerini yaz") yeniden yazmak genelde yardımcı
  olur; hâlâ takılıyorsa o adımı senaryodan çıkarıp basitleştirmeyi deneyin.
- **Sunucu hiç yanıt vermiyor / bağlantı reddediliyor:** `npm run dev` çalıştığı terminalde hata
  olup olmadığını kontrol edin; `http://localhost:4000/api/health` adresine tarayıcıdan gidip
  `{"status":"ok"}` benzeri bir yanıt aldığınızı doğrulayın.

## Bilinen sınırlamalar / sonraki adımlar

- **API endpoint'lerinde rate limiting yok**, CORS tamamen açık (`cors()` varsayılan ayarlarla) —
  bu proje şu an tek kullanıcılı/lokal kullanım için tasarlanmıştır; internete açık bir ortamda
  çalıştırmadan önce bu ikisi eklenmelidir.
- `TestRunStore` / `GeneratedTestStore`, dosya tabanlı (JSON index) append-only depolardır; eşzamanlı
  (concurrent) yazımlara karşı güvenli değildir. Tek kullanıcılı yerel kullanımda sorun teşkil etmez.
- Yoğun filtre panelli sayfalarda (ör. çok sayıda marka checkbox'ı olan bir e-ticaret arama sonucu),
  `AGENT_MAX_ELEMENTS_PER_STEP` sınırı nedeniyle sayfanın daha aşağısındaki bazı filtre alanları
  (ör. fiyat aralığı input'ları) ajana hiç gösterilmeyebilir — ajan bunu fark edip güvenli şekilde
  durur, ama senaryo tamamlanamaz. Gerekirse bu sınır artırılabilir ya da element önceliklendirme
  eklenebilir (bkz. `src/core/dom/DomAnalyzer.ts`).
- Şu an tek-instance bellek-içi `RunManager` (yeni API) ve tek-aktif-run `LegacyTestService`
  (eski API) kullanılıyor; yatay ölçeklenme gerekirse run durumu Redis gibi paylaşılan bir
  depoya taşınabilir (mimari buna uygun soyutlanmıştır).
- `LlmProvider` arayüzü sayesinde ileride OpenAI/Anthropic gibi başka sağlayıcılar
  `src/core/llm/createLlmProvider.ts` içine yeni bir `case` eklenerek kolayca desteklenebilir.
