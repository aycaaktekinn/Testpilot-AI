/**
 * v3.0 — Admin Panel domain tipleri (Faz 1: Project CRUD). Oracle'daki PROJECTS tablosunun
 * (bkz. db/migrations/001_initial_schema.sql) camelCase API/uygulama katmanı karşılığı —
 * ProjectStore.mapRow() bu iki temsil arasında çevirim yapar.
 */
export interface Project {
  id: number;
  name: string;
  /** Tanımlıysa bu projenin "Run Selected" akışında aynı anda kaç koşum yürütülebileceğini sınırlar. */
  maxParallelRuns: number | null;
  /** Admin tarafından elle girilir (bkz. sohbet notu: "model bilgisi admin panelinde manuel girilecek"). */
  llmModel: string | null;
  createdAt: string;
  createdBy: number | null;
}

/** Hem oluşturma HEM DÜZENLEME formunda kullanılır — admin panel modalı her zaman tüm alanları
 * birlikte gönderir (bkz. adminProjects.ts route dosya başı NOT), bu yüzden BİLİNÇLİ OLARAK ayrı
 * bir "partial update" tipi yok. */
export interface ProjectInput {
  name: string;
  maxParallelRuns?: number;
  llmModel?: string;
  /** v3.0 Faz 2 — sadece createProject()'te anlamlıdır (bkz. requireAdmin.authUser); güncellemede
   * yoksayılır, PROJECTS.CREATED_BY ilk oluşturmadan sonra bir daha DEĞİŞMEZ. */
  createdBy?: number;
}
