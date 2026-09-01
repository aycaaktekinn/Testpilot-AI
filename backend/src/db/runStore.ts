import oracledb from 'oracledb';
import { withConnection } from './oracleClient.js';

/**
 * v3.0 Faz 6 — bkz. scenarioStore.ts dosya başı NOT'u (aynı gerekçe/tasarım burada da geçerli).
 * Her test çalıştırması (generate-and-run / replay / batch içindeki her item) için TEK bir
 * WEB_SCENARIOS satırı + TEK bir WEB_RUNS satırı oluşturulur (mevcut JSON davranışıyla birebir aynı
 * semantik: "her çalıştırma yeni bir kayıt" — dedup/reuse mantığı YOK, bilinçli olarak).
 */
export interface CreateRunInput {
  scenarioId: number;
  projectId: number;
  status: 'passed' | 'failed';
  browserEngine: string;
  startedAt: Date;
  finishedAt: Date;
  startedBy: number | null;
  stepsJson: string | null;
}

export async function createRun(input: CreateRunInput): Promise<{ id: number }> {
  return withConnection(async (connection) => {
    const result = await connection.execute<{ id: number[] }>(
      `INSERT INTO WEB_RUNS (SCENARIO_ID, PROJECT_ID, STATUS, BROWSER_ENGINE, STARTED_AT, FINISHED_AT, STARTED_BY, STEPS_JSON)
       VALUES (:scenarioId, :projectId, :status, :browserEngine, :startedAt, :finishedAt, :startedBy, :stepsJson)
       RETURNING RUN_ID INTO :id`,
      {
        scenarioId: input.scenarioId,
        projectId: input.projectId,
        status: input.status,
        browserEngine: input.browserEngine,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        startedBy: input.startedBy,
        stepsJson: input.stepsJson === null ? null : { val: input.stepsJson, type: oracledb.CLOB },
        id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      },
    );
    await connection.commit();
    const newId = result.outBinds?.id?.[0];
    if (newId === undefined) {
      throw new Error('Koşum oluşturuldu ama RUN_ID okunamadı.');
    }
    return { id: newId };
  });
}

/**
 * v3.1 — Admin Panel "Delete Old Runs" bakım özelliği (bkz. sohbet notu: "silinenler veritabanından
 * da siliniyor mu"). WEB_RUNS satırları, JSON tarafındaki (TestRunStore) koşum kayıtlarından
 * BAĞIMSIZ, best-effort olarak yazılır (bkz. createRun() çağrı yeri, LegacyTestService) VE
 * aralarında birebir bir id eşlemesi (JSON runId <-> RUN_ID) YOK — bu yüzden burada da id bazlı
 * değil, AYNI eşik mantığıyla (FINISHED_AT < cutoff) tarih bazlı bir toplu silme yapılır.
 * FINISHED_AT kullanılıyor çünkü JSON tarafındaki LegacyRunRecord.createdAt, createRun()'a
 * `finishedAt: new Date(createdAt)` olarak birebir aktarılıyor (bkz. finalizeResult()) — yani iki
 * taraf da AYNI zaman damgasını temsil ediyor, eşik karşılaştırması bu sayede tutarlı.
 *
 * `startedBy` verilirse (MEMBER senaryosu — bkz. LegacyTestService.clearTestRunsBefore) SADECE o
 * kullanıcının başlattığı koşumlar hedeflenir; `null`/`undefined` ise (ADMIN) TÜM kullanıcıların
 * koşumları silinir.
 */
export async function deleteRunsBefore(cutoff: Date, startedBy?: number | null): Promise<number> {
  return withConnection(async (connection) => {
    const result =
      startedBy == null
        ? await connection.execute(`DELETE FROM WEB_RUNS WHERE FINISHED_AT < :cutoff`, { cutoff })
        : await connection.execute(`DELETE FROM WEB_RUNS WHERE FINISHED_AT < :cutoff AND STARTED_BY = :startedBy`, {
            cutoff,
            startedBy,
          });
    await connection.commit();
    return result.rowsAffected ?? 0;
  });
}

/**
 * v3.4 — bkz. sohbet notu: "test runs kısmından sile bastığımızda databaseden de siliyor mu".
 * Test Runs sayfasındaki TEKİL "Delete" butonu için — deleteRunsBefore()'daki AYNI kısıt burada
 * da geçerli: JSON runId <-> RUN_ID arasında birebir bir eşleme YOK, bu yüzden yine FINISHED_AT
 * eşleşmesiyle çalışılıyor (bkz. deleteRunsBefore dosya başı NOT'u) — ama bir ARALIK değil, TEK
 * bir zaman damgasına TAM eşitlik. Teorik olarak aynı milisaniyede biten birden fazla run varsa
 * (son derece olası değil) birden fazla satır silinebilir — bu, id eşlemesi hiç var olmadığı için
 * kabul edilen bir sınırlamadır (deleteRunsBefore ile AYNI best-effort felsefesi).
 */
export async function deleteRunByFinishedAt(finishedAt: Date, startedBy?: number | null): Promise<number> {
  return withConnection(async (connection) => {
    const result =
      startedBy == null
        ? await connection.execute(`DELETE FROM WEB_RUNS WHERE FINISHED_AT = :finishedAt`, { finishedAt })
        : await connection.execute(
            `DELETE FROM WEB_RUNS WHERE FINISHED_AT = :finishedAt AND STARTED_BY = :startedBy`,
            { finishedAt, startedBy },
          );
    await connection.commit();
    return result.rowsAffected ?? 0;
  });
}

/**
 * v3.4 — Test Runs sayfasındaki "Clear All" butonu için (Admin Panel'deki tarih bazlı "Delete Old
 * Runs" bakım özelliğinden AYRI — bkz. deleteRunsBefore). Tarih filtresi OLMADAN TÜM (ya da
 * `startedBy` verilmişse SADECE o kullanıcının) WEB_RUNS satırlarını siler — deleteRunsBefore ile
 * AYNI yetki deseni (startedBy==null -> ADMIN, tüm kullanıcılar; sayı verilirse -> sadece o
 * kullanıcı) ve AYNI best-effort felsefesi.
 */
export async function deleteAllRuns(startedBy?: number | null): Promise<number> {
  return withConnection(async (connection) => {
    const result =
      startedBy == null
        ? await connection.execute(`DELETE FROM WEB_RUNS`)
        : await connection.execute(`DELETE FROM WEB_RUNS WHERE STARTED_BY = :startedBy`, { startedBy });
    await connection.commit();
    return result.rowsAffected ?? 0;
  });
}
