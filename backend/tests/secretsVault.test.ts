import { describe, expect, it } from 'vitest';
import { SecretsVault } from '../src/core/secrets/SecretsVault.js';

describe('SecretsVault', () => {
  it('secret adlarını gösterir ama değerlerini asla göstermez', () => {
    const vault = new SecretsVault({ aramaTerimi: 'laptop' }, { PASSWORD: 'gizli-123' });
    const described = vault.describeForPrompt();

    expect(described.variableNames).toEqual(['aramaTerimi']);
    expect(described.secretNames).toEqual(['PASSWORD']);
    expect(JSON.stringify(described)).not.toContain('gizli-123');
  });

  it('placeholder değerleri gerçek değerlere çözer (resolve)', () => {
    const vault = new SecretsVault({ user: 'ayca' }, { PASSWORD: 'gizli-123' });

    expect(vault.resolve('{{var.user}}')).toBe('ayca');
    expect(vault.resolve('{{secret.PASSWORD}}')).toBe('gizli-123');
    expect(vault.resolve('sabit metin')).toBe('sabit metin');
  });

  it('loglama için secret placeholder değerini maskeler', () => {
    const vault = new SecretsVault({}, { PASSWORD: 'gizli-123' });
    expect(vault.maskForLog('{{secret.PASSWORD}}')).toBe('***');
    expect(vault.maskForLog('normal deger')).toBe('normal deger');
  });

  it('bilinmeyen secret/variable referanslarını tespit eder', () => {
    const vault = new SecretsVault({ known: '1' }, { KNOWN_SECRET: '2' });
    expect(vault.findUnknownReferences('{{var.bilinmeyen}}')).toEqual(['var.bilinmeyen']);
    expect(vault.findUnknownReferences('{{secret.YOK}}')).toEqual(['secret.YOK']);
    expect(vault.findUnknownReferences('{{var.known}} {{secret.KNOWN_SECRET}}')).toEqual([]);
  });

  it('serbest metinden bilinen secret değerlerini redakte eder', () => {
    const vault = new SecretsVault({}, { PASSWORD: 'sifre123' });
    const text = 'Hata: girilen değer sifre123 kabul edilmedi';
    expect(vault.redactSecretValuesFromText(text)).toBe('Hata: girilen değer *** kabul edilmedi');
  });

  // v3.47 — bkz. sohbet notu: "Get More Suggestions ... variable kısmında tanımları düzgün
  // uygulamıyorlar". Kullanıcı Login Variables tablosunda bir KEY'i boşluklu ("sicil no") girmiş,
  // LLM de bunu doğru şekilde "{{var.sicil no}}" olarak referans etmişti — ama ESKİ regex
  // (`[a-zA-Z0-9_\-]+`) boşluk kabul etmediği için bu hiç bir placeholder olarak TANINMIYOR, değer
  // hiç çözülmeden (literal metin olarak) kalıyordu. Bu test AYNEN o senaryoyu (boşluklu isim)
  // kapsar; ayrıca Türkçe karakterli bir isim ve fazladan boşluklu bir yazım da eklenmiştir.
  it('boşluk/Türkçe karakter içeren değişken ve secret adlarını da çözer', () => {
    const vault = new SecretsVault({ 'sicil no': 'VB12345' }, { 'şifre değeri': 'gizli-987' });

    expect(vault.resolve('{{var.sicil no}}')).toBe('VB12345');
    expect(vault.resolve('{{secret.şifre değeri}}')).toBe('gizli-987');
    // Fazladan boşluklu yazım (LLM "{{var. sicil no }}" gibi yazsa bile) da doğru çözülmeli.
    expect(vault.resolve('{{var. sicil no }}')).toBe('VB12345');
    // Bu artık TANINAN bir placeholder olduğu için "unknown reference" listesine düşmemeli.
    expect(vault.findUnknownReferences('{{var.sicil no}}')).toEqual([]);
  });
});
