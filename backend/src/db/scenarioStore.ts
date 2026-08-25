import oracledb from 'oracledb';
import { withConnection } from './oracleClient.js';

/**
 * v3.0 Faz 6 — Test Runs / Generated Tests artık (bkz. sohbet notu: "onlar da db ye kaydolması
 * lazım") en azından METADATA düzeyinde Oracle'a da yazılıyor. Bu dosya SADECE INSERT amaçlı
 * bilinçli olarak minimal tutuldu — mevcut JSON dosya tabanlı akış (GeneratedTestStore/TestRunStore)
 * DEĞİŞMEDEN duruyor, buradaki yazma tamamen EK (additive) ve best-effort: LegacyTestService
 * içinde try/catch ile sarılıp, hata olursa sadece log'lanıp asıl HTTP yanıtını ETKİLEMEZ (bkz.
 * finalizeResult()). SCENARIOS.PROJECT_ID NOT NULL olduğu için projectId bilinmeyen (ör. proje
 * seçilmeden yaratılmış eski testlerin tekrar çalıştırılması) durumlarda bu fonksiyon hiç
 * çağrılmaz — "sadece bundan sonrakiler DB'ye gitsin" kararı böylece doğal olarak sağlanıyor.
 */
export interface CreateScenarioInput {
  projectId: number;
  scenarioName: string;
  scenarioText: string;
  targetUrl: string;
  createdBy: number | null;
}

export async function createScenario(input: CreateScenarioInput): Promise<{ id: number }> {
  return withConnection(async (connection) => {
    const result = await connection.execute<{ id: number[] }>(
      `INSERT INTO SCENARIOS (PROJECT_ID, SCENARIO_NAME, SCENARIO_TEXT, TARGET_URL, CREATED_BY)
       VALUES (:projectId, :scenarioName, :scenarioText, :targetUrl, :createdBy)
       RETURNING SCENARIO_ID INTO :id`,
      {
        projectId: input.projectId,
        // SCENARIOS.SCENARIO_NAME VARCHAR2(200) — çağıran taraf (LegacyTestService) bu sınıra
        // göre önceden kırpıyor; burada tekrar kırpmıyoruz ki tek bir yerde (çağıran) yönetilsin.
        scenarioName: input.scenarioName,
        scenarioText: { val: input.scenarioText, type: oracledb.CLOB },
        targetUrl: input.targetUrl,
        createdBy: input.createdBy,
        id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
      },
    );
    await connection.commit();
    const newId = result.outBinds?.id?.[0];
    if (newId === undefined) {
      throw new Error('Senaryo oluşturuldu ama SCENARIO_ID okunamadı.');
    }
    return { id: newId };
  });
}
