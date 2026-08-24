import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LegacyGeneratedTestMeta } from '../../domain/legacyTypes.js';
import { env } from '../../config/env.js';
import { NotFoundError, ValidationError } from '../../domain/errors.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('GeneratedTestStore');

/** Sadece güvenli, bizim ürettiğimiz slug formatındaki dosya adlarını kabul eder (path traversal koruması). */
const SAFE_FILE_NAME = /^[a-zA-Z0-9_-]+\.spec\.ts$/;

/**
 * Sentezlenen "generated code"u gerçek .spec.ts dosyaları olarak diske yazar ve her biri için
 * orijinal çalıştırma bağlamını (url/scenario/variables/browser/options) bir index.json içinde
 * saklar — bu sayede "Run" butonu, sadece statik metni değil, ajanı YENİDEN çalıştırmak için
 * gereken tüm bilgiyi geri okuyabilir.
 */
export class GeneratedTestStore {
  private readonly dir: string;
  private readonly indexPath: string;

  constructor() {
    this.dir = path.resolve(env.GENERATED_TESTS_DIR);
    this.indexPath = path.join(this.dir, 'index.json');
  }

  async save(meta: LegacyGeneratedTestMeta, code: string): Promise<void> {
    assertSafeFileName(meta.fileName);
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, meta.fileName), code, 'utf-8');

    const all = await this.list();
    all.unshift(meta); // en yeni en başta
    await this.persistIndex(all);
  }

  /** En yeniden en eskiye sıralı döner (frontend "son üretilen" için tests[0]'ı kullanır). */
  async list(): Promise<LegacyGeneratedTestMeta[]> {
    try {
      const raw = await readFile(this.indexPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as LegacyGeneratedTestMeta[]) : [];
    } catch (err) {
      if (isNotFound(err)) return [];
      log.warn({ err }, 'generated-tests/index.json okunamadı, boş liste döndürülüyor');
      return [];
    }
  }

  async getMeta(fileName: string): Promise<LegacyGeneratedTestMeta> {
    assertSafeFileName(fileName);
    const all = await this.list();
    const found = all.find((t) => t.fileName === fileName);
    if (!found) throw new NotFoundError(`Üretilmiş test bulunamadı: ${fileName}`);
    return found;
  }

  async getCode(fileName: string): Promise<string> {
    assertSafeFileName(fileName);
    try {
      return await readFile(path.join(this.dir, fileName), 'utf-8');
    } catch {
      throw new NotFoundError(`Test kodu bulunamadı: ${fileName}`);
    }
  }

  /**
   * Hem diskteki .spec.ts dosyasını hem de index.json'daki kaydı siler. Kaynak-of-truth
   * index.json'dur: dosya diskten (ör. daha önce elle) zaten silinmişse bile index'teki kayıt
   * kaldırılır ve işlem başarılı sayılır — kullanıcı için asıl önemli olan "artık listede
   * görünmemesi"dir, fiziksel dosyanın var olup olmadığı değil.
   */
  async delete(fileName: string): Promise<void> {
    assertSafeFileName(fileName);

    const all = await this.list();
    const exists = all.some((t) => t.fileName === fileName);

    if (!exists) {
      throw new NotFoundError(`Üretilmiş test bulunamadı: ${fileName}`);
    }

    try {
      await unlink(path.join(this.dir, fileName));
    } catch (err) {
      if (!isNotFound(err)) {
        log.warn({ err, fileName }, 'Test dosyası diskten silinemedi (index.json yine de güncellenecek)');
      }
    }

    const remaining = all.filter((t) => t.fileName !== fileName);
    await this.persistIndex(remaining);
  }

  /**
   * v2.4 — kullanıcının verdiği özel görünen ismi (bkz. LegacyGeneratedTestMeta.displayName
   * dosya başı açıklaması) index.json'a kaydeder. Diskteki .spec.ts dosyasına DOKUNMAZ — sadece
   * bu tek alanı günceller, kaydın geri kalanı (fileName, url, replaySteps, vb.) AYNEN kalır.
   * Boş/whitespace-only bir isim gelirse özel ismi TAMAMEN KALDIRIR (frontend tekrar otomatik
   * dosya adını göstermeye döner) — bu şekilde kullanıcı ismi silip varsayılana dönebilir.
   */
  async rename(fileName: string, displayName: string): Promise<LegacyGeneratedTestMeta> {
    assertSafeFileName(fileName);

    const all = await this.list();
    const index = all.findIndex((t) => t.fileName === fileName);
    const existing = all[index];
    if (index === -1 || !existing) {
      throw new NotFoundError(`Üretilmiş test bulunamadı: ${fileName}`);
    }

    const trimmed = displayName.trim();
    const updated: LegacyGeneratedTestMeta = { ...existing, displayName: trimmed || undefined };
    all[index] = updated;

    await this.persistIndex(all);
    return updated;
  }

  /**
   * "Clear All" — listedeki her .spec.ts dosyasını diskten silmeyi dener (best-effort, tek
   * dosya başarısız olursa diğerlerini engellemez) ve index.json'ı boşaltır. Silinen kayıt
   * sayısını döner (frontend'in "X test silindi" gibi bir geri bildirim vermesi için).
   */
  async clear(): Promise<number> {
    const all = await this.list();

    await Promise.all(
      all.map(async (test) => {
        try {
          await unlink(path.join(this.dir, test.fileName));
        } catch (err) {
          if (!isNotFound(err)) {
            log.warn({ err, fileName: test.fileName }, 'Test dosyası diskten silinemedi (Clear All sırasında)');
          }
        }
      }),
    );

    await this.persistIndex([]);

    return all.length;
  }

  private async persistIndex(all: LegacyGeneratedTestMeta[]): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.indexPath, JSON.stringify(all, null, 2), 'utf-8');
    } catch (err) {
      log.error({ err }, 'generated-tests/index.json yazılamadı');
    }
  }
}

function assertSafeFileName(fileName: string): void {
  if (!SAFE_FILE_NAME.test(fileName)) {
    throw new ValidationError('Geçersiz dosya adı.');
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'ENOENT';
}

/**
 * Verilen metinden (v2.4 öncesi HER ZAMAN senaryo metniydi; v2.4 — bkz. LegacyTestService.
 * finalizeResult — kullanıcı bir test adı verdiyse artık ONDAN türetilir) ve runId'den güvenli,
 * benzersiz bir .spec.ts dosya adı üretir.
 */
export function buildGeneratedFileName(scenario: string, runId: string): string {
  const slug = scenario
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // NFKD sonrası ayrışan aksan işaretlerini kaldır (ör. ş -> s + kombine işaret)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 40);

  return `${slug || 'senaryo'}-${runId}.spec.ts`;
}
