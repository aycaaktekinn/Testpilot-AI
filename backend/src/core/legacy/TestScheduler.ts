import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import type { GeneratedTestSchedule } from '../../domain/legacyTypes.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('TestScheduler');

/**
 * v3.2 — "gece test koşumu" için jenerik, dosya-adı anahtarlı bir in-process cron yöneticisi
 * (bkz. sohbet notu). BİLİNÇLİ OLARAK LegacyTestService'ten TAMAMEN BAĞIMSIZDIR — hangi testin
 * NASIL çalıştırılacağını bilmez, sadece "bu zamanlamada, şu callback'i tetikle" der. Bu ayrım,
 * LegacyTestService <-> TestScheduler arasında dairesel import'u (circular import) ÖNLEMEK için
 * BİLİNÇLİ bir tasarım kararıdır: LegacyTestService zaten runGeneratedTestsBatch()'i çağırmak için
 * kendi metodlarına ihtiyaç duyar, bu modül ise sadece "ne zaman" sorusuyla ilgilenir.
 *
 * NEDEN sunucu SÜRECİ İÇİNDE (node-cron) — işletim sistemi cron'u DEĞİL: kullanıcı sohbette
 * onayladı ("sunucuyu gece de açık bırakıyoruz") — bu yüzden zamanlama SADECE sunucu süreci ayakta
 * iken tetiklenir; süreç yeniden başlarsa initSchedules() (bkz. LegacyTestService) tüm etkin
 * zamanlamaları sıfırdan kurar, süreç KAPALIYKEN kaçırılan bir tetikleme GERİ ÇALIŞTIRILMAZ.
 *
 * `time`, sunucunun kendi yerel saat dilimine göre yorumlanır (node-cron varsayılanı) — ayrı bir
 * saat dilimi seçimi BİLİNÇLİ OLARAK Faz 1'de yok, tek sunucu / tek saat dilimi varsayımıyla.
 */
const tasks = new Map<string, ScheduledTask>();

/** "HH:MM" + gün listesinden standart 5 alanlı bir cron ifadesi üretir (dakika saat * * gün,gün,...). */
export function buildCronExpression(schedule: GeneratedTestSchedule): string {
  const [hourStr, minuteStr] = schedule.time.split(':');
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const days = schedule.days.join(',');
  return `${minute} ${hour} * * ${days}`;
}

/**
 * Verilen fileName için ÖNCE var olan cron job'ı (varsa) durdurur, SONRA `schedule.enabled`
 * ise yeni bir tanesini kurar. Bu sayede hem "yeni zamanlama ekle", hem "mevcut zamanlamayı
 * güncelle", hem de "zamanlamayı devre dışı bırak" (enabled:false) AYNI fonksiyonla, tutarlı
 * şekilde ele alınır — çağıran taraf hangi durumda olduğunu ayrıca kontrol etmek ZORUNDA değildir.
 */
export function applySchedule(
  fileName: string,
  schedule: GeneratedTestSchedule | null | undefined,
  onTrigger: () => void,
): void {
  removeSchedule(fileName);

  if (!schedule?.enabled) return;

  const expression = buildCronExpression(schedule);
  if (!cron.validate(expression)) {
    log.warn({ fileName, expression, schedule }, 'Geçersiz cron ifadesi, zamanlama kurulamadı');
    return;
  }

  const task = cron.schedule(expression, () => {
    log.info({ fileName }, 'Zamanlanmış test tetiklendi');
    try {
      onTrigger();
    } catch (err) {
      log.error({ err, fileName }, 'Zamanlanmış test tetiklenirken beklenmeyen hata');
    }
  });
  tasks.set(fileName, task);
  log.info({ fileName, expression }, 'Zamanlama kuruldu');
}

export function removeSchedule(fileName: string): void {
  const existing = tasks.get(fileName);
  if (existing) {
    existing.stop();
    tasks.delete(fileName);
  }
}
