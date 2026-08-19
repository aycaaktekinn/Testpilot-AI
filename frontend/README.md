# AI Playwright Automation — Frontend

`backend/` API'sini kullanan, tek sayfa (SPA-benzeri) statik bir web arayüzü. Herhangi bir build
adımı veya framework yok — düz HTML, vanilla JavaScript ve Tailwind CSS (CDN üzerinden) ile
yazılmıştır. `backend`, bu klasörü kendi üzerinden (aynı origin'den) sunar; ayrı bir sunucu
kurmanıza veya CORS ayarı yapmanıza gerek yoktur (bkz. `backend/README.md` → Kurulum).

## İçindekiler

- [Mimari](#mimari)
- [Sayfalar](#sayfalar)
- [Backend ile iletişim](#backend-ile-iletişim)
- [Öne çıkan davranışlar](#öne-çıkan-davranışlar)
- [Geliştirme notları](#geliştirme-notları)

## Mimari

```
index.html                 ← sabit iskelet: sol menü (sidebar) + üstte başlık + #pageContent
   │
   └─ app.js  navigateTo(pageName)
         │
         ├─ fetch('/pages/<sayfa>.html')  → #pageContent.innerHTML olarak basılır
         │  (gerçek bir tarayıcı sayfa yenilemesi OLMAZ — sadece o bölüm değişir)
         │
         └─ init<Sayfa>Page()  → o sayfanın DOM elemanlarına event listener'ları bağlar
```

`pages/` klasöründeki her `.html` dosyası, `index.html`'in `#pageContent` alanına gömülen bir
**parça** (fragment)'tır — kendi başına açılabilecek bağımsız bir sayfa değildir. Menüden bir
sekmeye tıklamak `app.js`'teki `navigateTo()`'yu tetikler; bu fonksiyon ilgili parçayı fetch'ler,
DOM'a basar ve o sayfaya özel `init...Page()` fonksiyonunu çağırır (ör. `initCreateTestPage()`).
Uygulama durumu (`appState`), sayfa geçişleri arasında JS içinde bellekte tutulur — tarayıcı
`localStorage`/`sessionStorage` **bilinçli olarak minimal** kullanılır (yalnızca sayfalar arası
tek seferlik "aktarım" verileri için, bkz. [Öne çıkan davranışlar](#öne-çıkan-davranışlar)).

## Sayfalar

| Sayfa | Dosya | Ne işe yarar |
|---|---|---|
| Dashboard | `pages/dashboard.html` | Genel özet: son koşumlar, üretilen test sayısı, hızlı erişim butonları |
| Create Test | `pages/create-test.html` | Ana çalışma sayfası — URL + doğal dilde senaryo girip AI ajanını çalıştırma |
| Scenario Suggestions | `pages/scenario-suggestions.html` | Bir URL'yi taratıp AI'dan senaryo fikirleri isteme, kendi senaryonu ekleme |
| Generated Tests | `pages/generated-tests.html` | Geçmiş koşumlardan sentezlenen `.spec.ts` dosyalarının listesi (görüntüle/tekrar çalıştır/sil) |
| Test Runs | `pages/test-runs.html` | Tüm koşum geçmişi (PASS/FAIL, süre, tarayıcı motoru) ve detay görünümü |
| Reports | `pages/reports.html` | Allure raporu üretme ve açma |
| Settings | `pages/settings.html` | Backend'in o an kullandığı LLM/agent/Playwright yapılandırmasının salt-okunur özeti + varsayılan çalıştırma seçenekleri |

### Create Test — ana akış

1. **Target URL** ve **Test Scenario** (doğal dilde, adım adım anlatım) girilir. İsteğe bağlı
   olarak "Suggest Scenarios" ile o URL için AI'dan hazır senaryo önerileri alınabilir (bir modal
   içinde gösterilir).
2. **Variables & Secrets** tablosuna gerekli değerler eklenir. Secret'lar (şifre, token vb.)
   normal değişkenlerden ayrı tutulur ve senaryo metninde `{{secret.AD}}` şeklinde referans
   edilir — gerçek değer hiçbir zaman LLM'e gönderilmez (bkz. `backend/README.md` → Güvenlik).
3. **Headed mode**, **tarayıcı motoru** (chromium/firefox/webkit) ve **Screenshot/Video/Trace**
   yakalama seçenekleri belirlenir.
4. **Generate & Run Test** ile çalıştırılır; ilerleme canlı olarak **Execution Log** sekmesinde
   akar (WebSocket üzerinden). Devam eden bir koşum **Stop Test** ile iptal edilebilir.
5. Sonuç üç sekmede gösterilir: **Generated Code** (ajanın attığı adımlardan sentezlenen,
   yalnızca gerçek Playwright satırlarından oluşan okunabilir kod özeti — yorum satırı içermez),
   **Execution Log** (adım adım canlı çıktı) ve **Test Result** (PASS/FAIL, süre, exit code).
6. PASS/FAIL sonrası, yakalandıysa **Screenshots / Video / Trace** butonları etkinleşir — ana
   buton dosyayı yeni sekmede açar (görüntüleme), yanındaki ayrı indirme ikonu dosyayı doğrudan
   bilgisayara indirir.

### Scenario Suggestions — senaryo keşfi

- Bir URL girip **Get Suggestions** ile o sayfa gerçekten ziyaret edilir ve AI, sayfanın gerçek
  elementlerine dayanan 3-6 arası senaryo önerir.
- **Get More Suggestions** ile aynı URL için AI'dan ek, **tekrarlamayan** yeni öneriler istenebilir
  (önceki öneriler listeden silinmez, üzerine eklenir).
- **Add Your Own Scenario** ile kullanıcı kendi senaryosunu (başlık + metin) elle ekleyebilir —
  AI'ın önerdiği sayıyla sınırlı kalınmaz. Her kart (AI veya elle eklenmiş fark etmeksizin)
  **Copy**, **Use in Create Test** ve **Remove** aksiyonlarını destekler.
- "Use in Create Test", seçilen senaryoyu (ve taranan URL'yi) Create Test sayfasına tek seferlik
  bir `sessionStorage` aktarımıyla taşır — sayfa açıldığında otomatik doldurulur.

## Backend ile iletişim

Tüm istekler göreli yollarla (`fetch('/api/...')`) yapılır — frontend backend ile aynı origin'den
sunulduğu için ayrı bir base URL yapılandırmasına gerek yoktur. Create Test sayfasındaki canlı
ilerleme akışı, `POST /api/tests/generate-and-run` isteği sonuçlanmadan önce `GET
/api/tests/current-run-id` ile aktif `runId` öğrenilip `ws://<host>/ws/runs/<runId>` WebSocket
bağlantısı açılarak sağlanır. Kullanılan tüm uç noktaların tam listesi için `backend/README.md`
→ API bölümüne bakın.

## Öne çıkan davranışlar

- **Stop butonu dürüst geri bildirim verir.** Basılır basılmaz "durduruldu" denip canlı log akışı
  kesilmez — backend'in devam eden aksiyonu güvenli bir noktada gerçekten durdurmasını beklerken
  "Stop requested — waiting for the agent to reach a safe point to halt..." mesajı gösterilir,
  gerçek sonuç geldiğinde arayüz ona göre güncellenir.
- **`sessionStorage`'ın tek kullanım amacı**: Scenario Suggestions → Create Test arasındaki tek
  seferlik senaryo aktarımı (`testpilot.pendingSuggestion`). Okunur okunmaz hemen silinir; kalıcı
  bir tercih olarak saklanmaz.
- **Artifact indirme, görüntülemeden ayrıdır.** Screenshots/Video/Trace ana butonları dosyayı her
  zaman yeni sekmede açar; ayrı bir indirme ikonu (`<a download>`) doğrudan bilgisayara indirir —
  ikisi karıştırılmaz, kullanıcı hangisini istediğini seçer.

## Geliştirme notları

- Build adımı yoktur; `app.js` veya `pages/*.html` üzerinde yapılan bir değişikliği görmek için
  backend'i yeniden başlatmanıza gerek yoktur — tarayıcıda sayfayı yenilemeniz yeterlidir
  (statik dosyalar backend tarafından doğrudan diskten sunulur).
  `index.html` içindeki `<script src="./app.js">`'in **tek** giriş noktası olduğuna dikkat edin;
  `pages/*.html` dosyalarının kendi `<script>` etiketleri yoktur, hepsi `app.js`'in
  `init<Sayfa>Page()` fonksiyonları tarafından yönetilir.
- Yeni bir sayfa eklerken: `pages/` altına bir `.html` parçası ekleyin, `index.html`'deki sidebar'a
  bir menü öğesi ekleyin, `app.js`'teki `pageConfig` nesnesine kaydedin ve bir `init<Sayfa>Page()`
  fonksiyonu yazıp `initializePage()` içindeki switch'e ekleyin.
- Bu arayüz, backend'in eski (legacy) API sözleşmesine göre yazıldığı için **kasıtlı olarak** çok
  değiştirilmemiştir — backend tarafında yapılan mimari değişiklikler (`src/core/legacy/`), bu
  sözleşmeyi korumak üzere tasarlanmıştır (bkz. `backend/README.md` → Mevcut frontend uyum katmanı).
