import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import type { LegacySuite } from '../../domain/legacyTypes.js';
import { env } from '../../config/env.js';
import { NotFoundError } from '../../domain/errors.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('SuiteStore');

/**
 * v3.11 — "Suites" paneli için suite kayıtlarını (sadece {id, name, createdAt, ownerId} —
 * bkz. LegacySuite dosya başı açıklaması) tek bir JSON index dosyasında tutar. `TestRunStore`/
 * `GeneratedTestStore` ile AYNI append-only-index deseni: kaynak-of-truth tek bir JSON dosyası,
 * her işlem tüm listeyi okuyup değiştirip geri yazar. HANGİ testlerin bu suite'e ait olduğu
 * BURADA tutulmaz — bkz. LegacyGeneratedTestMeta.suiteIds dosya başı açıklaması.
 */
export class SuiteStore {
  private readonly indexPath: string;

  constructor() {
    this.indexPath = path.join(path.resolve(env.GENERATED_TESTS_DIR), 'suites-index.json');
  }

  async create(name: string, ownerId?: number | null): Promise<LegacySuite> {
    const suite: LegacySuite = {
      id: nanoid(12),
      name,
      createdAt: new Date().toISOString(),
      ownerId: ownerId ?? null,
    };

    const all = await this.list();
    all.unshift(suite); // en yeni en başta
    await this.persist(all);
    return suite;
  }

  /** En yeniden en eskiye sıralı döner (diğer index'lerle TUTARLI). */
  async list(): Promise<LegacySuite[]> {
    try {
      const raw = await readFile(this.indexPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as LegacySuite[]) : [];
    } catch (err) {
      if (isNotFound(err)) return [];
      log.warn({ err }, 'suites-index.json okunamadı, boş liste döndürülüyor');
      return [];
    }
  }

  async getById(id: string): Promise<LegacySuite> {
    const all = await this.list();
    const found = all.find((s) => s.id === id);
    if (!found) throw new NotFoundError(`Suite bulunamadı: ${id}`);
    return found;
  }

  /**
   * SADECE suites-index.json'daki kaydı siler. Bu suite'e ait testlerin `suiteIds` alanından
   * id'nin çıkarılması AYRI bir sorumluluktur (bkz. GeneratedTestStore.removeSuiteIdFromAll) —
   * çağıran (LegacyTestService.deleteSuite) ikisini birlikte yapar.
   */
  async delete(id: string): Promise<LegacySuite> {
    const all = await this.list();
    const suite = all.find((s) => s.id === id);

    if (!suite) {
      throw new NotFoundError(`Suite bulunamadı: ${id}`);
    }

    const remaining = all.filter((s) => s.id !== id);
    await this.persist(remaining);
    return suite;
  }

  private async persist(all: LegacySuite[]): Promise<void> {
    try {
      await mkdir(path.dirname(this.indexPath), { recursive: true });
      await writeFile(this.indexPath, JSON.stringify(all, null, 2), 'utf-8');
    } catch (err) {
      log.error({ err }, 'suites-index.json yazılamadı');
    }
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'ENOENT';
}
