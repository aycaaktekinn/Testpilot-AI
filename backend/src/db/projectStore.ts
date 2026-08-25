import oracledb from 'oracledb';
import { withConnection } from './oracleClient.js';
import type { Project, ProjectInput } from '../domain/adminTypes.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';

/**
 * v3.0 — PROJECTS tablosu için CRUD katmanı (Faz 1). adminProjects.ts route'u DOĞRUDAN Oracle
 * SQL'i görmez — hepsi burada, tek yerde toplanır (ileride Faz 4/5'te USERS/PROJECT_MEMBERS ile
 * JOIN'ler eklenince route katmanı değişmeden kalabilsin diye).
 */

// NOT — PROJECTS.GRID_URL sütunu BİLİNÇLİ OLARAK BURADA (ProjectRow/mapRow) YOK — v3.0 Faz 5'te
// kaldırıldı (bkz. BrowserManager.resolveGridUrl / adminSettings.ts dosya başı NOT'ları — proje
// bazlı Grid URL hiçbir zaman run yürütme koduna bağlanmamıştı, tek/global bir ayarla değiştirildi).
// SÜTUN KENDİSİ veritabanında hâlâ mevcut (yıkıcı olmayan değişiklik — silinmedi), sadece kod
// tarafında artık okunmuyor/yazılmıyor.
interface ProjectRow {
  PROJECT_ID: number;
  PROJECT_NAME: string;
  MAX_PARALLEL_RUNS: number | null;
  LLM_MODEL: string | null;
  CREATED_AT: Date;
  CREATED_BY: number | null;
}

function mapRow(row: ProjectRow): Project {
  return {
    id: row.PROJECT_ID,
    name: row.PROJECT_NAME,
    maxParallelRuns: row.MAX_PARALLEL_RUNS,
    llmModel: row.LLM_MODEL,
    createdAt: row.CREATED_AT.toISOString(),
    createdBy: row.CREATED_BY,
  };
}

/** ORA-00001 (unique constraint ihlali) yakalandığında kullanıcıya anlamlı bir hata döner;
 * başka herhangi bir Oracle hatası olduğu gibi yeniden fırlatılır. */
function rethrowFriendly(err: unknown): never {
  const oraError = err as { errorNum?: number };
  if (oraError.errorNum === 1) {
    throw new ValidationError('Bu proje adı zaten kullanılıyor.');
  }
  throw err as Error;
}

export async function listProjects(): Promise<Project[]> {
  return withConnection(async (connection) => {
    const result = await connection.execute<ProjectRow>(
      `SELECT PROJECT_ID, PROJECT_NAME, MAX_PARALLEL_RUNS, LLM_MODEL, CREATED_AT, CREATED_BY
       FROM PROJECTS
       ORDER BY CREATED_AT DESC`,
    );
    return (result.rows ?? []).map(mapRow);
  });
}

export async function getProject(id: number): Promise<Project> {
  return withConnection(async (connection) => {
    const row = await fetchProjectRow(connection, id);
    if (!row) {
      throw new NotFoundError(`Proje bulunamadı: ${id}`);
    }
    return mapRow(row);
  });
}

export async function createProject(input: ProjectInput): Promise<Project> {
  return withConnection(async (connection) => {
    try {
      const result = await connection.execute<{ id: number[] }>(
        `INSERT INTO PROJECTS (PROJECT_NAME, MAX_PARALLEL_RUNS, LLM_MODEL, CREATED_BY)
         VALUES (:name, :maxParallelRuns, :llmModel, :createdBy)
         RETURNING PROJECT_ID INTO :id`,
        {
          name: input.name,
          maxParallelRuns: input.maxParallelRuns ?? null,
          llmModel: input.llmModel ?? null,
          createdBy: input.createdBy ?? null,
          id: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER },
        },
      );
      await connection.commit();

      // NOT — outBinds'in anahtar adı, execute()'a verilen bindParams nesnesindeki anahtarla
      // (burada "id") BİREBİR AYNIDIR — SQL'deki ":id" placeholder'ının adıyla DEĞİL (aynı isim
      // olsa da bu bir tesadüf, ikisi ayrı kavramlar). Yanlışlıkla "ID" (büyük harf) yazılırsa
      // TypeScript hata vermez ama çalışma zamanında undefined döner — bkz. aşağıdaki kontrol.
      const newId = result.outBinds?.id?.[0];
      if (newId === undefined) {
        throw new Error('Proje oluşturuldu ama yeni PROJECT_ID okunamadı.');
      }

      const row = await fetchProjectRow(connection, newId);
      if (!row) {
        throw new Error('Proje oluşturuldu ama okunamadı.');
      }
      return mapRow(row);
    } catch (err) {
      return rethrowFriendly(err);
    }
  });
}

/** Bkz. ProjectInput dosya başı NOT — admin panel modalı her zaman TÜM düzenlenebilir alanları
 * birlikte gönderir, bu yüzden bu bilinçli olarak "tam güncelleme"dir: gönderilmeyen bir alan
 * NULL'a çekilir, kısmi/tekil alan güncellemesi (PATCH'in klasik anlamı) DEĞİLDİR. */
export async function updateProject(id: number, input: ProjectInput): Promise<Project> {
  return withConnection(async (connection) => {
    try {
      const existing = await fetchProjectRow(connection, id);
      if (!existing) {
        throw new NotFoundError(`Proje bulunamadı: ${id}`);
      }

      await connection.execute(
        `UPDATE PROJECTS
         SET PROJECT_NAME = :name,
             MAX_PARALLEL_RUNS = :maxParallelRuns,
             LLM_MODEL = :llmModel
         WHERE PROJECT_ID = :id`,
        {
          name: input.name,
          maxParallelRuns: input.maxParallelRuns ?? null,
          llmModel: input.llmModel ?? null,
          id,
        },
      );
      await connection.commit();

      const row = await fetchProjectRow(connection, id);
      if (!row) {
        throw new Error('Proje güncellendi ama okunamadı.');
      }
      return mapRow(row);
    } catch (err) {
      return rethrowFriendly(err);
    }
  });
}

/** PROJECT_MEMBERS/SCENARIOS/RUNS satırları ON DELETE CASCADE ile tanımlı (bkz. 001_initial_schema.sql)
 * — bu yüzden bir proje silindiğinde ona bağlı TÜM kayıtlar da otomatik silinir. Faz 1'de henüz
 * bu tablolara hiçbir şey yazılmıyor, dolayısıyla şu an için bu her zaman güvenli/etkisiz bir
 * detaydır; ileride (Faz 4+) gerçek veriler birikince "Sil" butonunun yanına bir uyarı eklenmesi
 * gerekebilir. */
export async function deleteProject(id: number): Promise<void> {
  return withConnection(async (connection) => {
    const result = await connection.execute(`DELETE FROM PROJECTS WHERE PROJECT_ID = :id`, { id });
    await connection.commit();

    if (!result.rowsAffected) {
      throw new NotFoundError(`Proje bulunamadı: ${id}`);
    }
  });
}

async function fetchProjectRow(connection: oracledb.Connection, id: number): Promise<ProjectRow | undefined> {
  const result = await connection.execute<ProjectRow>(
    `SELECT PROJECT_ID, PROJECT_NAME, MAX_PARALLEL_RUNS, LLM_MODEL, CREATED_AT, CREATED_BY
     FROM PROJECTS
     WHERE PROJECT_ID = :id`,
    { id },
  );
  return result.rows?.[0];
}
