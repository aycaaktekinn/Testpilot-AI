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
