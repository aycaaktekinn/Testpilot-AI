import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * v3.0 Faz 2 — kendi imzaladığımız, bağımsız (stateless) oturum token'ları. BİLİNÇLİ OLARAK
 * "jsonwebtoken" gibi yeni bir npm paketi EKLENMEDİ — burada ihtiyacımız olan tek şey "bu payload'ı
 * BEN imzaladım ve süresi geçmemiş" garantisi; Node'un "crypto" modülüyle HMAC-SHA256 imzalamak
 * bunun için yeterli ve fazladan bir bağımlılık/kurulum riski (bkz. oracledb sandbox sürtünmesi)
 * eklemiyor. Format standart JWT'ye BENZER (base64url(payload).base64url(imza)) ama TAM UYUMLU
 * DEĞİLDİR — sadece bu backend kendi ürettiği token'ları kendi doğruluyor, dışarıdan bir JWT
 * kütüphanesiyle karşılıklı çalışabilirlik GEREKMİYOR.
 */

export interface TokenPayload {
  userId: number;
  username: string;
  role: 'ADMIN' | 'MEMBER';
}

interface SignedPayload extends TokenPayload {
  exp: number;
}

export function signToken(payload: TokenPayload): string {
  const secret = requireSecret();
  const expiresAt = Date.now() + env.AUTH_TOKEN_TTL_HOURS * 60 * 60 * 1000;

  const body: SignedPayload = { ...payload, exp: expiresAt };
  const encodedBody = Buffer.from(JSON.stringify(body)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encodedBody).digest('base64url');

  return `${encodedBody}.${signature}`;
}

/** Geçersiz imza, bozuk format veya süresi geçmiş token için sessizce null döner — çağıran taraf
 * (requireAdmin middleware / /auth/me) bunu tek tip bir 401 olarak ele alır. */
export function verifyToken(token: string): SignedPayload | null {
  const secret = requireSecret();
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const [encodedBody, signature] = parts;
  if (!encodedBody || !signature) {
    return null;
  }

  const expectedSignature = createHmac('sha256', secret).update(encodedBody).digest('base64url');

  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encodedBody, 'base64url').toString('utf-8')) as SignedPayload;
    if (typeof parsed.exp !== 'number' || parsed.exp < Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function requireSecret(): string {
  if (!env.AUTH_TOKEN_SECRET) {
    // env.ts .superRefine bunu ORACLE_DB_HOST tanımlıyken zaten zorunlu kılıyor — buraya
    // düşülmesi normalde imkansız olmalı, ama defensif olarak yine de net bir hata fırlatılır.
    throw new Error('AUTH_TOKEN_SECRET tanımlı değil.');
  }
  return env.AUTH_TOKEN_SECRET;
}
