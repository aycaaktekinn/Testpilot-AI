import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * v3.0 Faz 2.3 — LDAP Manager Password gibi "diskte şifreli tutulması gereken" sırlar için genel
 * AES-256-GCM encrypt/decrypt yardımcıları. token.ts'in AYNI prensibi: BİLİNÇLİ OLARAK yeni bir npm
 * paketi (ör. bir "envelope encryption" kütüphanesi) EKLENMEDİ — Node'un kendi "crypto" modülü
 * yeterli.
 *
 * ANAHTAR NEREDEN GELİYOR — BİLİNÇLİ TASARIM KARARI: yeni, ayrı bir env var (ör.
 * LDAP_SECRET_KEY) İSTEMEK YERİNE, zaten zorunlu olan AUTH_TOKEN_SECRET'tan HKDF (RFC 5869) ile
 * AYRI, TEK YÖNLÜ türetilmiş bir AES anahtarı kullanılıyor (aşağıdaki sabit "info" string'i sayesinde
 * token imzalama anahtarından KRİPTOGRAFİK OLARAK bağımsız bir anahtar elde edilir — biri sızsa
 * diğerini çözmeye yaramaz). Kullanıcının .env dosyasında yönetmesi gereken bir sır DAHA eklememek,
 * kurulumu basit tutar (bkz. AUTH_TOKEN_SECRET'ın kendisinin bile kullanıcı için kafa karıştırıcı
 * olduğu — sohbet geçmişi) ve "iki secret'ı da rotate etmeyi unutma" riskini ortadan kaldırır.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM için önerilen (96 bit) IV uzunluğu.
const KEY_LENGTH = 32; // AES-256 -> 32 byte anahtar.
const HKDF_INFO = 'testpilot-ldap-manager-password-v1';

let cachedKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }
  if (!env.AUTH_TOKEN_SECRET) {
    // env.ts .superRefine bunu ORACLE_DB_HOST tanımlıyken zaten zorunlu kılıyor (LDAP config de
    // Oracle'a bağımlı) — buraya düşülmesi normalde imkansız olmalı, defensif hata.
    throw new Error('AUTH_TOKEN_SECRET tanımlı değil (LDAP şifreleme anahtarı türetilemiyor).');
  }
  const derived = hkdfSync('sha256', env.AUTH_TOKEN_SECRET, '', HKDF_INFO, KEY_LENGTH);
  cachedKey = Buffer.from(derived);
  return cachedKey;
}

/** Çıktı formatı: "<iv-hex>:<authTag-hex>:<ciphertext-hex>" — tek metin sütununda saklanabilsin diye. */
export function encryptSecret(plainText: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plainText, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/** Bozuk/eski formatta bir değerle karşılaşılırsa (ör. anahtar değiştiyse) null döner — çağıran
 * taraf bunu "LDAP şifresi çözülemedi, tekrar girilmeli" olarak ele almalı, uygulamayı çökertmemeli. */
export function decryptSecret(encoded: string): string | null {
  try {
    const key = getEncryptionKey();
    const parts = encoded.split(':');
    if (parts.length !== 3) {
      return null;
    }
    const [ivHex, authTagHex, cipherTextHex] = parts;
    if (!ivHex || !authTagHex || !cipherTextHex) {
      return null;
    }

    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(cipherTextHex, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf-8');
  } catch {
    return null;
  }
}
