import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * v3.0 Faz 2 — local kullanıcı şifreleri için scrypt tabanlı hashleme. BİLİNÇLİ OLARAK "bcrypt"
 * gibi yeni bir npm paketi EKLENMEDİ — Node'un kendi "crypto" modülündeki scrypt, bcrypt ile AYNI
 * amaca (yavaş, brute-force'a dirençli bir hash) hizmet eder ve hiçbir native derleme/kurulum
 * gerektirmez (bkz. oracledb'de yaşanan sandbox kurulum sürtünmesi — bir daha yaşamamak için).
 *
 * Saklama formatı: "<salt-hex>:<hash-hex>" — tek bir VARCHAR2 sütununda (USERS.PASSWORD_HASH)
 * tutulabilsin diye salt ve hash tek string'te birleştirilir.
 */

const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return `${salt}:${hash}`;
}

/** Zamanlama saldırılarına (timing attack) karşı sabit-zamanlı karşılaştırma kullanır — normal
 * "===" ile string karşılaştırmak, ilk farklı karakterde erken çıkarak hash hakkında bilgi sızdırabilir. */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) {
    return false;
  }

  const candidate = scryptSync(password, salt, KEY_LENGTH);
  const expected = Buffer.from(hash, 'hex');

  if (candidate.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(candidate, expected);
}
