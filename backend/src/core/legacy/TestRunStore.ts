import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LegacyRunRecord } from '../../domain/legacyTypes.js';
import { env } from '../../config/env.js';
import { NotFoundError } from '../../domain/errors.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('TestRunStore');

/**
 * Eski frontend'in GET /api/test-runs sayfaları (Test Runs, Reports, Dashboard, Generated Tests
 * özeti) için beklediği hafif koşum geçmişini tek bir JSON dosyasında (append-only index) tutar.
 * Bu, AgentLoop'un yazdığı DETAYLI adım-adım JSON loglarından (RunLogger) farklı ve ayrı bir
 * kayıttır — burası sadece liste/istatistik görünümleri için gereken özet alanları içerir.
 */
export class TestRunStore {
  private readonly indexPath: string;

  constructor() {
    this.indexPath = path.join(path.resolve(env.RUNS_DIR), 'test-runs-index.json');
  }

  async append(record: LegacyRunRecord): Promise<void> {
    const records = await this.list();
    records.unshift(record); // en yeni en başta
    await this.persist(records);
  }

  /** En yeniden en eskiye sıralı döner (frontend birçok yerde runs[0]'ı "son koşum" olarak kullanır). */
  async list(): Promise<LegacyRunRecord[]> {
    try {
      const raw = await readFile(this.indexPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as LegacyRunRecord[]) : [];
    } catch (err) {
      if (isNotFound(err)) return [];
      log.warn({ err }, 'test-runs-index.json okunamadı, boş liste döndürülüyor');
      return [];
    }
  }

  /**
   * Hem test-runs-index.json'daki özet kaydı hem de o run'a ait DETAYLI dosyaları (bkz. RunLogger —
   * RUNS_DIR/<runId>.json) hem de varsa artefaktları (bkz. AgentLoop — ARTIFACTS_DIR/<runId>/)
   * siler. Kaynak-of-truth index.json'dur: diğer dosyalar diskten zaten silinmiş/hiç oluşmamışsa
   * bile (ör. run hiç artefakt üretmediyse, ya da RunLogger yazımı daha önce başarısız olduysa)
   * işlem yine de başarılı sayılır — `force: true` bu yüzden hem `rm()`'e hem de best-effort
   * felsefesine uygun.
   *
   * v3.4 — silinen kaydı (void yerine) geri döner: bkz. LegacyTestService.deleteTestRun — çağıran,
   * bu kaydın `createdAt`/`ownerId` alanlarını Oracle WEB_RUNS'taki karşılığını (varsa) bulup
   * silmek için kullanıyor (JSON runId <-> RUN_ID arasında birebir bir eşleme YOK, bkz.
   * runStore.ts deleteRunByFinishedAt dosya başı NOT'u — bu yüzden silme SONRASI bu bilgiye artık
   * erişilemez, dolayısıyla burada, silmeden ÖNCE dışarı taşınması gerekiyor).
   */
  async delete(id: string): Promise<LegacyRunRecord> {
    const records = await this.list();
    const record = records.find((r) => r.id === id);

    if (!record) {
      throw new NotFoundError(`Koşum bulunamadı: ${id}`);
    }

    await this.deleteRunFiles(id);

    const remaining = records.filter((r) => r.id !== id);
    await this.persist(remaining);
    return record;
  }

  /**
   * "Clear All" — listedeki her run'ın detay dosyasını/artefaktlarını silmeyi dener (best-effort,
   * tek run başarısız olursa diğerlerini engellemez) ve index.json'ı boşaltır (ya da `predicate`
   * verildiyse SADECE ona uyan kayıtları). Silinen kayıt sayısını döner (frontend'in "X koşum
   * silindi" gibi bir geri bildirim vermesi için).
   *
   * v3.1 — `predicate` OPSİYONEL: verilmezse eski davranış (hepsini sil) AYNEN korunur — admin
   * için "Clear All" hâlâ gerçekten her şeyi temizler. Member için LegacyTestService, sadece
   * kendi `ownerId`'siyle eşleşen kayıtları hedefleyen bir predicate geçer — bu sayede "Clear All"
   * butonu member'da SADECE kendi koşumlarını temizler, başkalarının kayıtlarına dokunmaz.
   */
  async clear(predicate?: (record: LegacyRunRecord) => boolean): Promise<number> {
    const records = await this.list();
    const toDelete = predicate ? records.filter(predicate) : records;

    if (toDelete.length === 0) return 0;

    await Promise.all(toDelete.map((r) => this.deleteRunFiles(r.id)));

    if (predicate) {
      const deleteIds = new Set(toDelete.map((r) => r.id));
      const remaining = records.filter((r) => !deleteIds.has(r.id));
      await this.persist(remaining);
    } else {
      await this.persist([]);
    }

    return toDelete.length;
  }

  private async deleteRunFiles(id: string): Promise<void> {
    await Promise.all([
      rm(path.join(path.resolve(env.RUNS_DIR), `${id}.json`), { force: true }).catch((err) => {
        log.warn({ err, id }, 'Run detay dosyası silinemedi (index yine de güncellenecek)');
      }),
      rm(path.join(path.resolve(env.ARTIFACTS_DIR), id), { recursive: true, force: true }).catch((err) => {
        log.warn({ err, id }, 'Run artefaktları silinemedi (index yine de güncellenecek)');
      }),
    ]);
  }

  private async persist(records: LegacyRunRecord[]): Promise<void> {
    try {
      await mkdir(path.dirname(this.indexPath), { recursive: true });
      await writeFile(this.indexPath, JSON.stringify(records, null, 2), 'utf-8');
    } catch (err) {
      log.error({ err }, 'test-runs-index.json yazılamadı');
    }
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'ENOENT';
}
