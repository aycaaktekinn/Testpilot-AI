/**
 * SecretsVault
 * ------------
 * Kullanıcının verdiği "variables" (hassas olmayan) ve "secrets" (hassas) değerlerini yönetir.
 *
 * Kritik güvenlik kuralı:
 *  - Secret DEĞERLERİ hiçbir zaman LLM prompt'una veya log dosyalarına yazılmaz.
 *  - LLM'e ve loglara sadece secret ADLARI ve placeholder söz dizimi (örn. "{{secret.PASSWORD}}") gösterilir.
 *  - Gerçek değer, yalnızca Playwright aksiyonu uygulanacağı anda, bellekte resolve edilir.
 */

// v3.47 — bkz. sohbet notu: "Get More Suggestions ... variable kısmında tanımları düzgün
// uygulamıyorlar". Canlı run kayıtlarında (ör. suggest-login-Lm2Fh-Bsi6.json) LLM'in
// "{{var.sicil no}}" (ADINDA BOŞLUK VAR — kullanıcı, Login Variables tablosunda KEY'i "sicil no"
// olarak, iki kelime halinde girmiş) yazdığı görüldü. ESKİ desen `[a-zA-Z0-9_\-]+` SADECE harf/
// rakam/alt çizgi/tire kabul ediyordu — BOŞLUK (ve Türkçe İ/ı/ş/ğ/ç/ö/ü gibi harfler DIŞINDAKİ
// tüm özel karakterler) bu sınıfa DAHİL DEĞİLDİ. Sonuç: "{{var.sicil no}}" bu regex'e HİÇ
// UYMUYORDU — `resolve()` bunu bir placeholder olarak TANIMIYOR, DEĞİŞTİRMEDEN bırakıyordu; yani
// alana GERÇEK sicil no DEĞİL, "{{var.sicil no}}" metninin KENDİSİ yazılıyordu. Sitenin bunu
// (açıkça geçersiz bir sicil no formatı) anında sıfırlaması ("Değer yazıldı ama sayfa tarafından
// anında sıfırlandı") bu yüzden aslında bir SİTE TUHAFLIĞI değil, DOĞRUDAN bu eksik regex'in
// sonucuydu — bu conuşmada BİRDEN FAZLA kez "sicil no alanı sıfırlanıyor" olarak gözlemlenen
// sorunun asıl kök nedeni muhtemelen HEP buydu. `findUnknownReferences()` de AYNI deseni
// kullandığı için bunu "unknown reference" olarak da YAKALAYAMIYORDU (regex hiç eşleşmediği için
// kontrol hiç çalışmıyordu) — yani run'ı güvenli şekilde erken durduran bir savunma ağı da yoktu.
// Düzeltme: isim sınıfını `}` ve `{` DIŞINDAKİ HER ŞEYİ kabul edecek şekilde genişlettik (boşluk,
// Türkçe harfler, noktalama — kullanıcı frontend'deki "KEY Name" alanına ne yazarsa yazsın çalışır)
// — tek istisna `{`/`}` (başka bir placeholder'ın sınırına yanlışlıkla taşmaması için). Adın
// başında/sonunda kalabilecek rastgele boşluklara karşı da aşağıda `.trim()` uygulanıyor.
const SECRET_REF_PATTERN = /\{\{\s*secret\.([^{}]+?)\s*\}\}/g;
const VARIABLE_REF_PATTERN = /\{\{\s*var\.([^{}]+?)\s*\}\}/g;

export class SecretsVault {
  private readonly variables: Map<string, string>;
  private readonly secrets: Map<string, string>;

  constructor(variables: Record<string, string> = {}, secrets: Record<string, string> = {}) {
    this.variables = new Map(Object.entries(variables));
    this.secrets = new Map(Object.entries(secrets));
  }

  /** LLM'e gösterilecek güvenli özet: secret'ların sadece adları, değerleri değil. */
  describeForPrompt(): { variableNames: string[]; secretNames: string[]; variables: Record<string, string> } {
    return {
      variableNames: [...this.variables.keys()],
      secretNames: [...this.secrets.keys()],
      // Değişkenler hassas olmadığı için değerleriyle birlikte gösterilebilir; bu modelin
      // örn. "ara: {{var.aramaTerimi}}" yerine doğrudan doğru metni kullanmasını kolaylaştırır.
      variables: Object.fromEntries(this.variables),
    };
  }

  hasSecret(name: string): boolean {
    return this.secrets.has(name);
  }

  hasVariable(name: string): boolean {
    return this.variables.has(name);
  }

  /**
   * LLM'in döndürdüğü ham value string'ini gerçek değere çevirir (Playwright'a göndermeden hemen önce).
   * Placeholder yoksa değeri olduğu gibi döner.
   */
  resolve(rawValue: string | undefined): string | undefined {
    if (rawValue === undefined) return undefined;

    // v3.47 — bkz. dosya başı NOT'u: `.trim()`, yakalanan ismin başında/sonunda kalabilecek
    // rastgele boşluklara (ör. LLM "{{var. sicil no }}" gibi fazladan boşluklu yazarsa) karşı
    // Map anahtarıyla (ki o da genelde zaten trim'li girilir) tutarlı eşleşme sağlar.
    let resolved = rawValue.replace(VARIABLE_REF_PATTERN, (_match, name: string) => {
      const value = this.variables.get(name.trim());
      return value ?? _match;
    });

    resolved = resolved.replace(SECRET_REF_PATTERN, (_match, name: string) => {
      const value = this.secrets.get(name.trim());
      return value ?? _match;
    });

    return resolved;
  }

  /** Loglama/prompt için değeri maskeler: secret placeholder'ı varsa "***" döner. */
  maskForLog(rawValue: string | undefined): string | undefined {
    if (rawValue === undefined) return undefined;
    if (SECRET_REF_PATTERN.test(rawValue)) {
      SECRET_REF_PATTERN.lastIndex = 0;
      return rawValue.replace(SECRET_REF_PATTERN, '***');
    }
    return rawValue;
  }

  /** rawValue içinde tanımsız bir secret/variable referansı var mı kontrol eder (güvenli durma için). */
  findUnknownReferences(rawValue: string | undefined): string[] {
    if (!rawValue) return [];
    const unknown: string[] = [];

    for (const match of rawValue.matchAll(SECRET_REF_PATTERN)) {
      const name = match[1]?.trim();
      if (name && !this.secrets.has(name)) unknown.push(`secret.${name}`);
    }
    for (const match of rawValue.matchAll(VARIABLE_REF_PATTERN)) {
      const name = match[1]?.trim();
      if (name && !this.variables.has(name)) unknown.push(`var.${name}`);
    }
    return unknown;
  }

  /**
   * Herhangi bir serbest metinden (örn. hata mesajları, DOM içerikleri) bilinen secret
   * DEĞERLERİNİ tarayıp maskeler. Loglara/prompt'lara sızma riskine karşı ikinci savunma katmanı.
   */
  redactSecretValuesFromText(text: string): string {
    let output = text;
    for (const value of this.secrets.values()) {
      if (!value) continue;
      output = output.split(value).join('***');
    }
    return output;
  }
}
