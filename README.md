# AI Playwright Automation

Doğal dilde yazdığınız web test senaryolarını, yapay zekâ (LLM) ve Playwright kullanarak otomatik
olarak çalıştıran bir web test otomasyon aracı. **Herhangi bir siteye özel değildir** — e-ticaret,
admin panel, CRM, SaaS veya herhangi bir web uygulamasında kullanılabilir.

CSS selector, XPath ya da hazır bir Playwright script'i yazmanıza gerek yoktur. Sadece test etmek
istediğiniz sayfanın URL'sini ve ne yapılması gerektiğini normal cümlelerle anlatırsınız (ör.
*"Arama kutusuna 'kablosuz kulaklık' yaz ve ara, ilk sonuca tıkla, ürün sayfasının açıldığını
doğrula."*) — sistem gerisini kendisi halleder.

## Bu proje ne yapmıyor (önemli bir netlik)

Bu araç senaryonuzdan önceden sabit bir test script'i **üretip onu çalıştırmaz**. Böyle bir sistem,
sayfa en ufak değiştiğinde (bir buton yeri değişse, yeni bir çerez pop-up'ı çıksa) bozulur.

Bunun yerine: her adımda sayfanın **o anki gerçek halini** açıp bakar, yapay zekâya "sayfada şu an
bunlar var, senaryo bunu istiyor, sıradaki TEK aksiyon ne olmalı?" diye sorar, kararı doğrulayıp
güvenli şekilde uygular, sonra tekrar bakar. Bu "algıla → karar ver → uygula → tekrar algıla"
döngüsü, senaryo bitene ya da yapay zekâ bir belirsizlikle karşılaşıp güvenli şekilde durana kadar
devam eder. Bir test koştuktan sonra, geriye dönük **okunabilir bir kod özeti** de üretilir
(denetim/dokümantasyon amaçlı) — ama testi tekrar çalıştırdığınızda o statik kod değil, yine canlı
ajan çalışır.

## Proje yapısı

```
backend/    Node.js + TypeScript API — ajan döngüsü, Playwright, LLM entegrasyonu
            (bkz. backend/README.md — mimari, güvenlik tasarımı, API referansı)
frontend/   Statik web arayüzü — backend tarafından aynı adresten sunulur
            (bkz. frontend/README.md — sayfa sayfa arayüz mimarisi)
```

## Kurulum ve çalıştırma

> Gereksinim: **Node.js 18.18+**

```bash
git clone <bu-repo>
cd <bu-repo>/backend

cp .env.example .env
# .env dosyasını açıp en azından OPENROUTER_API_KEY değerini girin
# (https://openrouter.ai/keys üzerinden alınır)

npm install
npm run playwright:install     # Chromium + Firefox + WebKit tarayıcılarını indirir

npm run dev                    # geliştirme modu
# veya production için:
npm run build && npm start
```

Sunucu ayağa kalktıktan sonra tarayıcınızda **`http://localhost:4000/`** adresini açın. Frontend'i
ayrıca kurmanıza/çalıştırmanıza gerek yoktur — backend, `frontend/` klasörünü aynı adresten
otomatik olarak sunar.

Detaylı ortam değişkeni açıklamaları (LLM sağlayıcı seçimi, güvenlik limitleri, timeout'lar vb.)
için `backend/README.md` → *Ortam değişkenleri* bölümüne bakın.

## Kullanım kılavuzu

Uygulama açıldığında solda bir menü, sağda ilgili sayfanın içeriği görürsünüz. Aşağıda her sayfanın
ne için kullanıldığı ve tipik bir kullanım akışı anlatılmıştır.

### 1. Bir test oluşturup çalıştırma — "Create Test"

Bu, uygulamanın ana sayfasıdır.

1. **Target URL** alanına test etmek istediğiniz sayfanın adresini yazın.
2. **Test Scenario** alanına, yapılması gerekenleri normal cümlelerle, adım adım anlatın. Fikir
   bulamıyorsanız **Suggest Scenarios** butonuna basın — sistem sayfayı gerçekten ziyaret edip
   sayfaya özgü hazır senaryo önerileri gösterir.
3. Senaryonuz kullanıcı adı/şifre gibi bir bilgi gerektiriyorsa, bunları senaryo metnine
   **doğrudan yazmayın**. Sayfanın altındaki **Variables & Secrets** tablosuna ekleyin; şifre gibi
   hassas değerleri "Secret" olarak işaretleyin. Senaryonuzda bunlara `{{var.ALAN_ADI}}` veya
   `{{secret.ALAN_ADI}}` şeklinde referans verin — gerçek şifre değeri yapay zekâya **hiçbir
   zaman** gönderilmez, sadece adı gösterilir.
4. İsterseniz tarayıcıyı görünür şekilde çalıştırmayı (**Headed mode**), farklı bir tarayıcı
   motorunu (Chromium/Firefox/WebKit) ve ekran görüntüsü/video/trace kaydını açabilirsiniz.
5. **Generate & Run Test**'e basın. İlerlemeyi **Execution Log** sekmesinden canlı takip
   edebilirsiniz. Vazgeçmek isterseniz **Stop Test**'e basın — sistem devam eden adımı güvenli bir
   noktada gerçekten durdurup size bunu bildirir (anında "durduruldu" yazıp arkada çalışmaya devam
   etmez).
6. Test bittiğinde üç sekmeye bakabilirsiniz: **Generated Code** (yapılan adımların okunabilir kod
   özeti), **Execution Log** (adım adım kayıt) ve **Test Result** (Başarılı/Başarısız, süre).
   Ekran görüntüsü/video/trace kaydettiyseniz, ilgili butonlarla görüntüleyebilir ya da yanındaki
   indirme ikonuyla bilgisayarınıza indirebilirsiniz.

### 2. Senaryo fikri bulma — "Scenario Suggestions"

Ne test edeceğinizden emin değilseniz bu sayfayı kullanın. Bir URL girip **Get Suggestions**'a
basın; sistem sayfayı ziyaret edip gerçek elementlerine dayanan birkaç senaryo önerir. Beğendiğiniz
bir öneriyi **Use in Create Test** ile doğrudan Create Test sayfasına taşıyabilir, **Copy** ile
panoya kopyalayabilirsiniz. Daha fazla fikir isterseniz **Get More Suggestions**'a basın — sistem
önceki önerileri tekrar etmeden yenilerini ekler. Kendi senaryonuzu yazmak isterseniz **Add Your
Own Scenario** ile listeye elle senaryo ekleyebilirsiniz; AI'ın önerdiği sayıyla sınırlı değilsiniz.

### 3. Geçmiş test kodları — "Generated Tests"

Her tamamlanan koşumdan sonra, o koşumun adımlarından sentezlenmiş, okunabilir bir kod dosyası
kaydedilir. Bu sayfadan geçmiş dosyaları görüntüleyebilir, aynı senaryoyu (sayfanın **o anki**
güncel haliyle) tekrar çalıştırabilir veya silebilirsiniz.

### 4. Koşum geçmişi — "Test Runs"

Bugüne kadar çalıştırdığınız tüm testlerin listesi: durum (Başarılı/Başarısız), süre, kullanılan
tarayıcı motoru. Bir kayda tıklayarak detaylarını görebilirsiniz.

### 5. Raporlama — "Reports"

Kayıtlı koşum sonuçlarından, paylaşılabilir statik bir **Allure** HTML raporu üretip
açabilirsiniz.

### 6. Genel özet — "Dashboard"

Son koşumlara, üretilen test sayısına ve sık kullanılan aksiyonlara hızlı erişim.

### 7. Yapılandırma özeti — "Settings"

O an hangi yapay zekâ sağlayıcısının/modelinin kullanıldığı, güvenlik limitleri (maksimum adım
sayısı, güven eşiği vb.) ve Playwright ayarlarının salt-okunur bir özeti. Buradan `.env`
dosyasını değiştiremezsiniz — değişiklik için `backend/.env` dosyasını düzenleyip sunucuyu
yeniden başlatmanız gerekir.

## Güvenlik ve gizlilik ilkeleri

- **Şifreler/API anahtarları asla yapay zekâya gönderilmez.** Sadece adları (`{{secret.AD}}`
  placeholder'ı) gösterilir; gerçek değer yalnızca tarayıcıya uygulanırken, bellekte çözülür.
- **Belirsizlikte tahmin yürütülmez.** Yapay zekâ bir sonraki adımdan emin değilse (ör. bir alanın
  etiket mi giriş kutusu mu olduğu net değilse), yanlış bir yere tıklamak yerine testi güvenli
  şekilde durdurur ve nedenini açıklar.
- **Halüsinasyon koruması.** Yapay zekâ, sadece o anda sayfada gerçekten var olduğu doğrulanmış
  elementlere aksiyon uygulayabilir; var olmayan bir elemente "tıkla" derse bu reddedilir.
- **Sonsuz döngü koruması.** Aynı aksiyon sayfa durumu hiç değişmeden art arda tekrarlanırsa,
  sistem bunu tespit edip testi güvenli şekilde durdurur.

Teknik detaylar için `backend/README.md` → *Güvenlik tasarımı* bölümüne bakın.

## Sık karşılaşılan durumlar

- **Test uzun süre "takılı" görünüyor:** Genelde ücretsiz yapay zekâ modelinin o an yavaş yanıt
  vermesindendir; sistem belirli bir süre sonra otomatik olarak yeniden dener, hâlâ başarısızsa
  anlaşılır bir hata mesajıyla durur.
- **Bir sitede sürekli "güven eşiğinin altında durdu" görüyorum:** Bu bir hata değil, bilinçli bir
  güvenlik davranışıdır — yapay zekâ o adımda emin olamadığı için yanlış tıklamak yerine durmuştur.
  Senaryodaki o adımı biraz daha açık/adım adım anlatmayı deneyin.
- **Belirli bir aksiyon (ör. sepete ekleme) her seferinde giriş sayfasına yönlendiriyor:** Bazı
  siteler bu aksiyon için oturum açmış olmanızı zorunlu kılar; bu durumda senaryonuzu o adımdan
  önce bitirecek şekilde (ör. sadece ürün sayfasına kadar) yeniden yazmanız gerekebilir.

Daha ayrıntılı sorun giderme rehberi için `backend/README.md` → *Sorun giderme* bölümüne bakın.

## Daha fazla bilgi

- [`backend/README.md`](backend/README.md) — mimari, ajan döngüsü, güvenlik tasarımı, ortam
  değişkenleri, API referansı, test, sorun giderme, bilinen sınırlamalar.
- [`frontend/README.md`](frontend/README.md) — arayüz mimarisi, sayfa sayfa açıklamalar, backend
  ile iletişim.
