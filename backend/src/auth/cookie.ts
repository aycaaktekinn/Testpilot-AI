import type { Request } from 'express';
import { env } from '../config/env.js';

/**
 * v3.0 Faz 2 — minimal, bağımsız cookie yardımcıları. BİLİNÇLİ OLARAK "cookie-parser" gibi yeni
 * bir npm paketi EKLENMEDİ — tek ihtiyacımız TEK bir cookie'yi okumak/yazmak, bunun için
 * `req.headers.cookie` string'ini elle ayrıştırmak yeterli (bkz. token.ts/password.ts'deki AYNI
 * "gerekmedikçe yeni bağımlılık ekleme" prensibi).
 */

export const AUTH_COOKIE_NAME = 'testpilot_auth';

export function getAuthCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) {
    return null;
  }

  for (const part of header.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = part.slice(0, separatorIndex).trim();
    if (key !== AUTH_COOKIE_NAME) continue;

    const value = part.slice(separatorIndex + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }

  return null;
}

/** Login başarılı olduğunda Set-Cookie header'ı için değer üretir. httpOnly: tarayıcı JS'i
 * (document.cookie) bu cookie'yi HİÇ okuyamaz — token'ı localStorage'da tutmaktan (XSS'e karşı
 * çok daha kırılgan) BİLİNÇLİ OLARAK kaçınıldı. sameSite=Lax: farklı bir siteden yapılan
 * isteklerde cookie gönderilmez (CSRF'e karşı temel bir koruma), ama aynı origin'den normal
 * navigasyon/fetch'lerde (bu uygulamanın kullanım şekli) sorunsuz çalışır. */
export function serializeAuthCookie(token: string, maxAgeSeconds: number): string {
  const encoded = encodeURIComponent(token);
  return `${AUTH_COOKIE_NAME}=${encoded}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeSeconds)}${secureSuffix()}`;
}

/** Logout için — Max-Age=0 tarayıcıya cookie'yi HEMEN silmesini söyler. */
export function clearAuthCookieHeader(): string {
  return `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureSuffix()}`;
}

/** NODE_ENV=production DIŞINDA (yani yerel geliştirmede, http://localhost üzerinde) "Secure"
 * bayrağı BİLİNÇLİ OLARAK eklenmez — Secure cookie'ler sadece HTTPS üzerinden gönderilir, yerel
 * http://localhost geliştirmede eklenirse tarayıcı cookie'yi HİÇ göndermez, login sessizce
 * "çalışmıyormuş" gibi görünürdü. Gerçek/kurumsal bir dağıtımda (NODE_ENV=production, HTTPS
 * arkasında) otomatik olarak eklenir. */
function secureSuffix(): string {
  return env.NODE_ENV === 'production' ? '; Secure' : '';
}
