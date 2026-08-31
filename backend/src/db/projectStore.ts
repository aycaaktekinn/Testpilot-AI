import oracledb from 'oracledb';
import { withConnection } from './oracleClient.js';
import type { Project, ProjectInput, ProjectMember } from '../domain/adminTypes.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';

/**
 * v3.0 — WEB_PROJECTS tablosu için CRUD katmanı (Faz 1). adminProjects.ts route'u DOĞRUDAN Oracle
 * SQL'i görmez — hepsi burada, tek yerde toplanır (ileride Faz 4/5'te WEB_USERS/WEB_PROJECT_MEMBERS ile
 * JOIN'ler eklenince route katmanı değişmeden kalabilsin diye).
 */

// NOT — WEB_PROJECTS.GRID_URL sütunu BİLİNÇLİ OLARAK BURADA (ProjectRow/mapRow) YOK — v3.0 Faz 5'te
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
       FROM WEB_PROJECTS
       ORDER BY CREATED_AT DESC`,
    );
    return (result.rows ?? []).map(mapRow);
  });
}

/**
 * v3.1 — MEMBER rolündeki kullanıcılar için: sadece WEB_PROJECT_MEMBERS'ta kendisine atanmış
 * projeleri döner (bkz. projects.ts route'undaki dosya başı NOT — ADMIN hâlâ `listProjects()` ile
 * hepsini görür, bu fonksiyon SADECE MEMBER için kullanılır).
 */
export async function listProjectsForUser(userId: number): Promise<Project[]> {
  return withConnection(async (connection) => {
    const result = await connection.execute<ProjectRow>(
      `SELECT p.PROJECT_ID, p.PROJECT_NAME, p.MAX_PARALLEL_RUNS, p.LLM_MODEL, p.CREATED_AT, p.CREATED_BY
       FROM WEB_PROJECTS p
       INNER JOIN WEB_PROJECT_MEMBERS pm ON pm.PROJECT_ID = p.PROJECT_ID
       WHERE pm.USER_ID = :userId
       ORDER BY p.CREATED_AT DESC`,
      { userId },
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
        `INSERT INTO WEB_PROJECTS (PROJECT_NAME, MAX_PARALLEL_RUNS, LLM_MODEL, CREATED_BY)
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
        `UPDATE WEB_PROJECTS
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

/** WEB_PROJECT_MEMBERS/WEB_SCENARIOS/WEB_RUNS satırları ON DELETE CASCADE ile tanımlı (bkz. 001_initial_schema.sql)
 * — bu yüzden bir proje silindiğinde ona bağlı TÜM kayıtlar da otomatik silinir. Faz 1'de henüz
 * bu tablolara hiçbir şey yazılmıyor, dolayısıyla şu an için bu her zaman güvenli/etkisiz bir
 * detaydır; ileride (Faz 4+) gerçek veriler birikince "Sil" butonunun yanına bir uyarı eklenmesi
 * gerekebilir. */
export async function deleteProject(id: number): Promise<void> {
  return withConnection(async (connection) => {
    const result = await connection.execute(`DELETE FROM WEB_PROJECTS WHERE PROJECT_ID = :id`, { id });
    await connection.commit();

    if (!result.rowsAffected) {
      throw new NotFoundError(`Proje bulunamadı: ${id}`);
    }
  });
}

/**
 * v3.1 — Admin Panel / Proje Üye Ataması (bkz. sohbet notu: "admin panelden proje ataması
 * yapacağız"). WEB_PROJECT_MEMBERS o güne kadar hiçbir kod tarafından yazılmıyordu (bkz. dosya başı
 * NOT — "ileride Faz 4/5'te ... JOIN'ler eklenince" öngörüsü, işte o Faz). Bu üç fonksiyon
 * WEB_PROJECT_MEMBERS için TEK CRUD katmanı — adminProjects.ts route'u da (Project CRUD'daki gibi)
 * DOĞRUDAN Oracle SQL'i görmez.
 */
interface ProjectMemberRow {
  USER_ID: number;
  USERNAME: string;
  DISPLAY_NAME: string | null;
  ROLE: 'ADMIN' | 'MEMBER';
  ASSIGNED_AT: Date;
}

function mapMemberRow(row: ProjectMemberRow): ProjectMember {
  return {
    id: row.USER_ID,
    username: row.USERNAME,
    displayName: row.DISPLAY_NAME,
    role: row.ROLE,
    assignedAt: row.ASSIGNED_AT.toISOString(),
  };
}

/** ADMIN dahil TÜM kullanıcılar üye olarak eklenebilir (bkz. sohbet notu: "Hepsi listelensin
 * (ADMIN dahil)") — ADMIN zaten listProjects()'le her projeyi gördüğü için bu satırın
 * görünürlüğe pratik bir etkisi yok, sadece admin panelinde kimin "resmi olarak" atanmış
 * göründüğünü belirler. */
export async function listProjectMembers(projectId: number): Promise<ProjectMember[]> {
  return withConnection(async (connection) => {
    const result = await connection.execute<ProjectMemberRow>(
      `SELECT u.USER_ID, u.USERNAME, u.DISPLAY_NAME, u.ROLE, pm.ASSIGNED_AT
       FROM WEB_PROJECT_MEMBERS pm
       INNER JOIN WEB_USERS u ON u.USER_ID = pm.USER_ID
       WHERE pm.PROJECT_ID = :projectId
       ORDER BY pm.ASSIGNED_AT DESC`,
      { projectId },
    );
    return (result.rows ?? []).map(mapMemberRow);
  });
}

/** Zaten üye olan bir kullanıcı tekrar eklenmeye çalışılırsa (ORA-00001 — WEB_PROJECT_MEMBERS'ın
 * PROJECT_ID+USER_ID birleşik PK'si ihlal edilir) sessizce no-op sayılır: idempotent davranış,
 * frontend'in ayrıca "zaten ekli mi" kontrolü yapmasına gerek bırakmaz. Proje ya da kullanıcı id'si
 * geçersizse (ORA-02291, FK ihlali) NotFoundError'a çevrilir. */
export async function addProjectMember(projectId: number, userId: number): Promise<void> {
  return withConnection(async (connection) => {
    try {
      await connection.execute(`INSERT INTO WEB_PROJECT_MEMBERS (PROJECT_ID, USER_ID) VALUES (:projectId, :userId)`, {
        projectId,
        userId,
      });
      await connection.commit();
    } catch (err) {
      const oraError = err as { errorNum?: number };
      if (oraError.errorNum === 1) {
        return;
      }
      if (oraError.errorNum === 2291) {
        throw new NotFoundError('Proje veya kullanıcı bulunamadı.');
      }
      throw err as Error;
    }
  });
}

export async function removeProjectMember(projectId: number, userId: number): Promise<void> {
  return withConnection(async (connection) => {
    const result = await connection.execute(
      `DELETE FROM WEB_PROJECT_MEMBERS WHERE PROJECT_ID = :projectId AND USER_ID = :userId`,
      { projectId, userId },
    );
    await connection.commit();

    if (!result.rowsAffected) {
      throw new NotFoundError('Kullanıcı bu projeye zaten üye değil.');
    }
  });
}

async function fetchProjectRow(connection: oracledb.Connection, id: number): Promise<ProjectRow | undefined> {
  const result = await connection.execute<ProjectRow>(
    `SELECT PROJECT_ID, PROJECT_NAME, MAX_PARALLEL_RUNS, LLM_MODEL, CREATED_AT, CREATED_BY
     FROM WEB_PROJECTS
     WHERE PROJECT_ID = :id`,
    { id },
  );
  return result.rows?.[0];
}
