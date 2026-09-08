#!/bin/bash

# Allure Kurulum ve Yapılandırma Scripti
# Bu script, macOS'ta Allure'un düzgün çalışması için gerekli kontrolleri yapar

echo "🔍 Allure Kurulum Kontrolü"
echo "=========================="

# Java kontrolü
echo -n "☕ Java versiyonu: "
if command -v java &> /dev/null; then
    JAVA_VERSION=$(java -version 2>&1 | head -n 1)
    echo "✅ $JAVA_VERSION"
else
    echo "❌ Java bulunamadı! Lütfen Java 17+ yükleyin."
    echo "   Örnek: brew install openjdk@17"
    exit 1
fi

# Allure CLI kontrolü
echo -n "📦 Allure CLI: "
if [ -f "./node_modules/.bin/allure" ]; then
    echo "✅ node_modules/.bin/allure mevcut"
else
    echo "❌ Allure CLI bulunamadı!"
    echo "   Lütfen 'npm install' çalıştırın."
    exit 1
fi

# JAVA_HOME kontrolü
if [ -n "$JAVA_HOME" ]; then
    echo "✅ JAVA_HOME: $JAVA_HOME"
else
    echo "⚠️  JAVA_HOME tanımlı değil, ancak Java PATH'te bulunuyor"
fi

echo ""
echo "✅ Tüm kontroller başarılı!"
echo ""
echo "📝 Kullanım:"
echo "   npm run allure:generate    # Rapor oluştur"
echo "   npm run allure:open        # Raporu aç"
echo "   npm run allure:serve       # Canlı önizleme başlat"
echo ""