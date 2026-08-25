import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { env } from '../config/env.js';
import { hashPassword } from '../auth/password.js';
import { initOraclePool, closeOraclePool } from './oracleClient.js';
import { createLocalUser, getUserByUsername } from './userStore.js';
import { createLogger } from '../config/logger.js';

const log = createLogger('createAdminUser');

/**
 * v3.0 Faz 2 — İLK admin kullanıcıyı oluşturmak için terminal script'i (`npm run create-admin`).
 * BİLİNÇLİ OLARAK bir "signup" API/UI endpoint'i YOK — bir admin panelinde kendi kendine üye
 * olma/admin atama akışı açmak güvenlik açısından yanlış olurdu; ilk admin sadece sunucuya
 * TERMINAL erişimi olan biri tarafından, bu script ile oluşturulabilir. Sonraki admin/üye
 * kullanıcılar (Faz 4) admin panelin KENDİSİNDEN eklenebilecek.
 *
 * NOT — şifre girilirken terminal ekranda GİZLENMEZ (readline'ın maskeleme desteği yok); yerel
 * geliştirme/tek seferlik kurulum senaryosu için kabul edilebilir bir sınırlama.
 */
async function main() {
  if (!env.ORACLE_DB_HOST) {
    throw new Error('ORACLE_DB_HOST tanımlı değil — önce .env dosyanıza Oracle ayarlarını ekleyin (bkz. .env.example).');
  }

  const rl = createInterface({ input: stdin, output: stdout });

  const username = (await rl.question('Kullanıcı adı: ')).trim();
  const displayName = (await rl.question('Görünen ad (opsiyonel, boş bırakabilirsiniz): ')).trim();
  const password = await rl.question('Şifre (ekranda gizlenmez): ');

  rl.close();

  if (!username) {
    throw new Error('Kullanıcı adı boş olamaz.');
  }
  if (!password || password.length < 6) {
    throw new Error('Şifre en az 6 karakter olmalı.');
  }

  await initOraclePool();

  try {
    const existing = await getUserByUsername(username);
    if (existing) {
      throw new Error(`"${username}" kullanıcı adı zaten kayıtlı.`);
    }

    const user = await createLocalUser({
      username,
      passwordHash: hashPassword(password),
      displayName: displayName || null,
      role: 'ADMIN',
    });

    log.info({ userId: user.id, username: user.username }, 'Admin kullanıcı oluşturuldu — artık bu bilgilerle giriş yapabilirsiniz');
  } finally {
    await closeOraclePool();
  }
}

main().catch((err) => {
  log.error({ err }, 'Admin kullanıcı oluşturulamadı');
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
