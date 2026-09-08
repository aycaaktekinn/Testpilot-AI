# Allure Kullanım Kılavuzu

## 🎯 Hızlı Başlangıç

### 1. İlk Kurulum

```bash
cd backend

# Kurulum kontrolü
./scripts/setup-allure.sh

# Eğer Java bulunamazsa:
echo 'export PATH="/opt/homebrew/opt/openjdk@25/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

### 2. Test Çalıştır ve Rapor Oluştur

```bash
# Testleri çalıştır (sonuçlar allure-results'a kaydedilir)
npm test

# Rapor oluştur
npm run allure:generate

# Raporu aç
npm run allure:open
```

## 📊 Kullanım Senaryoları

### Senaryo 1: Manuel Test ve Raporlama

```bash
# 1. Backend'i başlat
npm run dev

# 2. Frontend'den test çalıştır (http://localhost:4000)
# Testler otomatik olarak allure-results'a kaydedilir

# 3. Yeni bir terminalde rapor oluştur ve aç
npm run allure:generate
npm run allure:open
```

### Senaryo 2: Canlı Geliştirme (Önerilen)

```bash
# Terminal 1: Backend
npm run dev

# Terminal 2: Canlı Allure önizleme
npm run allure:serve

# Terminal 3: Testleri çalıştır
npm test

# Tarayıcıda otomatik açılan raporu izleyin!
# Her test çalıştırıldığında sayfayı yenileyin
```

### Senaryo 3: CI/CD Pipeline

```bash
# .github/workflows/test.yml örneği:

name: Test & Report

on: [push, pull_request]

jobs:
  test:
    runs-on: macos-latest
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Java
        uses: actions/setup-java@v3
        with:
          java-version: '25'
          distribution: 'homebrew'
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: |
          cd backend
          npm install
      
      - name: Run tests
        run: |
          cd backend
          npm test
      
      - name: Generate Allure Report
        run: |
          cd backend
          npm run allure:generate
      
      - name: Upload Allure Report
        uses: actions/upload-artifact@v3
        with:
          name: allure-report
          path: backend/allure-report
```

## 🔧 Komut Referansı

### `npm run allure:generate`

Test sonuçlarından statik HTML raporu oluşturur.

```bash
# Temiz rapor oluştur
npm run allure:generate

# Manuel olarak
./node_modules/.bin/allure generate allure-results -o allure-report --clean
```

**Çıktı:** `allure-report/` klasörü

### `npm run allure:open`

Oluşturulmuş raporu varsayılan tarayıcıda açar.

```bash
npm run allure:open

# Manuel olarak
./node_modules/.bin/allure open allure-report
```

**Not:** Rapor yoksa önce `generate` çalıştırın.

### `npm run allure:serve`

Canlı önizleme sunucusu başlatır (önerilen).

```bash
npm run allure:serve
```

**Özellikler:**
- Otomatik tarayıcı açma
- Test çalıştırıldığında otomatik yenileme
- Geçici HTTP sunucusu (varsayılan port 6060)

**Kullanım:**
```bash
# 1. Serve başlat
npm run allure:serve

# 2. Testleri çalıştır
npm test

# 3. Tarayıcıda raporu yenile
```

### `./scripts/setup-allure.sh`

Kurulum kontrolü yapar.

```bash
./scripts/setup-allure.sh
```

**Kontrol Edilenler:**
- ✅ Java versiyonu (17+)
- ✅ Allure CLI varlığı
- ✅ JAVA_HOME environment variable

## 📁 Dosya Yapısı

```
backend/
├── allure-results/              # Ham test sonuçları
│   ├── [uuid]-result.json      # Test sonuç JSON'ları
│   ├── [uuid]-attachment.png   # Ekran görüntüleri
│   ├── [uuid]-attachment.mp4   # Video kayıtları
│   └── [uuid]-attachment.zip   # Trace dosyaları
│
├── allure-report/               # Oluşturulmuş HTML raporu
│   ├── index.html              # Ana sayfa
│   ├── widgets/                # Widget'lar
│   │   ├── behaviors.html
│   │   ├── categories.html
│   │   ├── timeline.html
│   │   └── ...
│   └── exporters/              # Dışa aktarma
│
├── .allurerc.json              # Allure konfigürasyonu
└── scripts/
    └── setup-allure.sh         # Kurulum kontrolü
```

## 🎨 Rapor Özellikleri

### Ana Bölümler

1. **Overview** - Genel bakış
   - Test istatistikleri
   - Durum dağılımı
   - Trend grafiği

2. **Behaviors** - Davranışlar
   - Feature'lara göre gruplama
   - User story'ler

3. **Packages** - Paketler
   - Test suite'lere göre gruplama

4. **Suites** - Test Suite'leri
   - Detaylı test hiyerarşisi

5. **Timeline** - Zaman Çizelgesi
   - Testlerin zaman içindeki çalışması
   - Paralel çalışma görünümü

6. **Testers** - Testçiler
   - Testçi bazlı istatistikler

7. **Categories** - Kategoriler
   - Başarısızlık kategorileri

8. **Environment** - Ortam
   - Test ortam bilgileri

### Widget'lar

- **Behaviors**: Feature ve story bazlı görünüm
- **Timeline**: Zaman çizelgesi
- **Test Runs**: Test çalıştırma geçmişi
- **Packages**: Paket yapısı
- **Environment-info**: Ortam bilgileri

## 🔍 Rapor Özelleştirme

### `.allurerc.json` Konfigürasyonu

```json
{
  "plugins": [
    "packages",
    "behaviors",
    "timeline",
    "test-runs",
    "environment-info"
  ]
}
```

### Environment Bilgileri Eklemek

`allure-results` klasörüne `environment.properties` ekleyin:

```properties
browser=Chrome 120
os=macOS 14.2
environment=Development
url=http://localhost:4000
```

### Kategoriler Eklemek

`allure-results` klasörüne `categories.json` ekleyin:

```json
{
  "categories": [
    {
      "name": "Infrastructure problems",
      "messageRegex": ".*5[0-9][0-9].*"
    },
    {
      "name": "Product bugs",
      "messageRegex": ".*AssertionError.*"
    }
  ]
}
```

## 🐛 Sorun Giderme

### "Allure CLI bulunamadı"

```bash
# node_modules'u yeniden yükleyin
cd backend
rm -rf node_modules
npm install

# Binary'yi kontrol edin
ls -la node_modules/.bin/allure
```

### "Java bulunamadı"

```bash
# Java versiyonunu kontrol edin
java -version

# Eğer bulunamazsa PATH'e ekleyin
echo 'export PATH="/opt/homebrew/opt/openjdk@25/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# JAVA_HOME'i ayarlayın
echo 'export JAVA_HOME=/opt/homebrew/opt/openjdk@25' >> ~/.zshrc
source ~/.zshrc
```

### Rapor Boş Görünüyor

```bash
# 1. Test çalıştırın
npm test

# 2. Sonuçları kontrol edin
ls -la allure-results/*.json

# 3. Rapor oluşturun
npm run allure:generate

# 4. Raporu kontrol edin
ls -la allure-report/
```

### Port Çakışması (allure:serve)

```bash
# Varsayılan port 6060 kullanılır
# Port çakışırsa manuel port belirtin:
./node_modules/.bin/allure serve allure-results --port 8080
```

### Eski Raporlar Temizleme

```bash
# Tüm sonuçları ve raporları temizle
rm -rf allure-results allure-report

# Veya backend'den:
curl -X DELETE http://localhost:4000/api/allure/results
```

## 📚 İpuçları

### 1. Düzenli Kullanım

```bash
# Her test çalıştırmasından sonra:
npm test && npm run allure:serve
```

### 2. Rapor Paylaşımı

```bash
# Raporu ZIP olarak paketleyin
cd backend
zip -r allure-report.zip allure-report

# GitHub Pages'a yükle
# Veya şirket içi sunucuya deploy et
```

### 3. CI/CD Entegrasyonu

```bash
# GitHub Actions örneği
- name: Generate Allure Report
  run: npm run allure:generate

- name: Upload Report
  uses: actions/upload-artifact@v3
  with:
    name: allure-report
    path: backend/allure-report
```

### 4. Performans İzleme

- **Timeline** widget'ını kullanın
- Test süresi trendlerini takip edin
- Paralel çalıştırma fırsatlarını belirleyin

## 🌐 Frontend Entegrasyonu

Backend otomatik olarak Allure raporlarını sunar:

```javascript
// Rapor durumunu kontrol et
const status = await fetch('/api/allure/status');

// Rapor oluştur
await fetch('/api/allure/generate', { method: 'POST' });

// Raporu aç
window.open('/allure-report', '_blank');

// Sonuçları temizle
await fetch('/api/allure/results', { method: 'DELETE' });
```

## 📖 Kaynaklar

- [Allure Report Documentation](https://allurereport.org/)
- [Allure Playwright](https://www.npmjs.com/package/allure-playwright)
- [Allure Commandline](https://github.com/allure-framework/allure2)
- [Allure GitHub](https://github.com/allure-framework)

## 🤝 Destek

Sorularınız için:
- GitHub Issues
- Allure Documentation
- Proje README'si