import oracledb from 'oracledb';
import { withConnection } from './oracleClient.js';
import type { Project, ProjectInput, ProjectMember } from '../domain/adminTypes.js';
import { NotFoundError, ValidationError } from '../domain/errors.js';
import { createLogger } from '../config/logger.js';

const log = createLogger('projectStore');

type ProjectTableName = 'WEB_PROJECTS' | 'PROJECTS';
type MemberTableName = 'WEB_PROJECT_MEMBERS' | 'PROJECT_MEMBERS';

interface ProjectTableChoice {
  hasWebProjects: boolean;
  hasLegacyProjects: boolean;
  webProjectRowCount: number;
  legacyProjectRowCount: number;
}

interface MemberTableChoice {
  hasWebMembers: boolean;
  hasLegacyMembers: boolean;
  webMemberRowCount: number;
  legacyMemberRowCount: number;
}

export function chooseProjectTable(input: ProjectTableChoice): ProjectTableName {
  if (input.hasLegacyProjects && !input.hasWebProjects) return 'PROJECTS';
  if (input.hasWebProjects && !input.hasLegacyProjects) return 'WEB_PROJECTS';
  if (input.legacyProjectRowCount > input.webProjectRowCount) return 'PROJECTS';
  return 'WEB_PROJECTS';
}

export function chooseMembershipTable(input: MemberTableChoice): MemberTableName {
  if (input.hasLegacyMembers && !input.hasWebMembers) return 'PROJECT_MEMBERS';
  if (input.hasWebMembers && !input.hasLegacyMembers) return 'WEB_PROJECT_MEMBERS';
  if (input.legacyMemberRowCount > input.webMemberRowCount) return 'PROJECT_MEMBERS';
  return 'WEB_PROJECT_MEMBERS';
}

async function detectTableCounts(connection: oracledb.Connection, tableName: string): Promise<{ exists: boolean; rowCount: number }> {
  try {
    const result = await connection.execute<{ COUNT: number }>(`SELECT COUNT(*) AS COUNT FROM ${tableName}`);
    return { exists: true, rowCount: Number(result.rows?.[0]?.COUNT ?? 0) };
  } catch (err) {
    const oraError = err as { errorNum?: number };
    if (oraError.errorNum === 942) {
      return { exists: false, rowCount: 0 };
    }
    throw err;
  }
}

async function resolveProjectTable(connection: oracledb.Connection): Promise<ProjectTableName> {
  const [web, legacy] = await Promise.all([
    detectTableCounts(connection, 'WEB_PROJECTS'),
    detectTableCounts(connection, 'PROJECTS'),
  ]);

  return chooseProjectTable({
    hasWebProjects: web.exists,
    hasLegacyProjects: legacy.exists,
    webProjectRowCount: web.rowCount,
    legacyProjectRowCount: legacy.rowCount,
  });
}

async function resolveMemberTable(connection: oracledb.Connection): Promise<MemberTableName> {
  const [web, legacy] = await Promise.all([
    detectTableCounts(connection, 'WEB_PROJECT_MEMBERS'),
    detectTableCounts(connection, 'PROJECT_MEMBERS'),
  ]);

  return chooseMembershipTable({
    hasWebMembers: web.exists,
    hasLegacyMembers: legacy.exists,
    webMemberRowCount: web.rowCount,
    legacyMemberRowCount: legacy.rowCount,
  });
}

/**
 * v3.0 — WEB_PROJECTS tablosu için CRUD katmanı (Faz 1). adminProjects.ts route'u DOĞRUDAN Oracle
 * SQL'i görmez — hepsi burada, tek yerde toplanır (ileride Faz 4/5'te WEB_USERS/WEB_PROJECT_MEMBERS ile
 * JOIN'ler eklenince route katmanı değişmeden kalabilsin diye).
 *
 * NOT — yerel Oracle örneğinde DB kısmen yeniden adlandırılmış olabilir: hem yeni WEB_* tablosu hem
 * eski legacy PROJECTS/PROJECT_MEMBERS birlikte bulunabilir. Bu durumda "gerçek veri taşıyan tablo"
 * belirlenip ona göre okuma/yazma yapılır; aksi halde üyelik atamaları boş görünür.
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
    const table = await resolveProjectTable(connection);
    const result = await connection.execute<ProjectRow>(
      `SELECT PROJECT_ID, PROJECT_NAME, MAX_PARALLEL_RUNS, LLM_MODEL, CREATED_AT, CREATED_BY
       FROM ${table}
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
    const projectTable = await resolveProjectTable(connection);
    const memberTable = await resolveMemberTable(connection);
    const result = await connection.execute<ProjectRow>(
      `SELECT p.PROJECT_ID, p.PROJECT_NAME, p.MAX_PARALLEL_RUNS, p.LLM_MODEL, p.CREATED_AT, p.CREATED_BY
       FROM ${projectTable} p
       INNER JOIN ${memberTable} pm ON pm.PROJECT_ID = p.PROJECT_ID
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
      const table = await resolveProjectTable(connection);
      const result = await connection.execute<{ id: number[] }>(
        `INSERT INTO ${table} (PROJECT_NAME, MAX_PARALLEL_RUNS, LLM_MODEL, CREATED_BY)
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
      const table = await resolveProjectTable(connection);
      const existing = await fetchProjectRow(connection, id);
      if (!existing) {
        throw new NotFoundError(`Proje bulunamadı: ${id}`);
      }

      await connection.execute(
        `UPDATE ${table}
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
    const table = await resolveProjectTable(connection);
    const result = await connection.execute(`DELETE FROM ${table} WHERE PROJECT_ID = :id`, { id });
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
    assignedAt: row.ASSIGNED_AT ? row.ASSIGNED_AT.toISOString() : null,
  };
}

/** ADMIN dahil TÜM kullanıcılar üye olarak eklenebilir (bkz. sohbet notu: "Hepsi listelensin
 * (ADMIN dahil)") — ADMIN zaten listProjects()'le her projeyi gördüğü için bu satırın
 * görünürlüğe pratik bir etkisi yok, sadece admin panelinde kimin "resmi olarak" atanmış
 * göründüğünü belirler. */
export async function listProjectMembers(projectId: number): Promise<ProjectMember[]> {
  return withConnection(async (connection) => {
    const memberTable = await resolveMemberTable(connection);
    const selectAssignmentColumn = memberTable === 'WEB_PROJECT_MEMBERS' ? 'pm.ASSIGNED_AT' : 'CAST(NULL AS TIMESTAMP) AS ASSIGNED_AT';
    const result = await connection.execute<ProjectMemberRow>(
      `SELECT u.USER_ID, u.USERNAME, u.DISPLAY_NAME, u.ROLE, ${selectAssignmentColumn}
       FROM ${memberTable} pm
       INNER JOIN WEB_USERS u ON u.USER_ID = pm.USER_ID
       WHERE pm.PROJECT_ID = :projectId
       ORDER BY ${memberTable === 'WEB_PROJECT_MEMBERS' ? 'pm.ASSIGNED_AT' : 'u.USER_ID'} DESC`,
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
    const memberTable = await resolveMemberTable(connection);
    try {
      await connection.execute(`INSERT INTO ${memberTable} (PROJECT_ID, USER_ID) VALUES (:projectId, :userId)`, {
        projectId,
        userId,
      });
      await connection.commit();
    } catch (err) {
      const oraError = err as { errorNum?: number; message?: string };
      if (oraError.errorNum === 2291) {
        log.warn({ projectId, userId, err }, 'addProjectMember: FK ihlali (ORA-02291)');
      }
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
    const memberTable = await resolveMemberTable(connection);
    const result = await connection.execute(
      `DELETE FROM ${memberTable} WHERE PROJECT_ID = :projectId AND USER_ID = :userId`,
      { projectId, userId },
    );
    await connection.commit();

    if (!result.rowsAffected) {
      throw new NotFoundError('Kullanıcı bu projeye zaten üye değil.');
    }
  });
}

async function fetchProjectRow(connection: oracledb.Connection, id: number): Promise<ProjectRow | undefined> {
  const table = await resolveProjectTable(connection);
  const result = await connection.execute<ProjectRow>(
    `SELECT PROJECT_ID, PROJECT_NAME, MAX_PARALLEL_RUNS, LLM_MODEL, CREATED_AT, CREATED_BY
     FROM ${table}
     WHERE PROJECT_ID = :id`,
    { id },
  );
  return result.rows?.[0];
}
