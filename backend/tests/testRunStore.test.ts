import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { baseEnv } from './helpers/fakeEnv.js';
import type { LegacyRunRecord } from '../src/domain/legacyTypes.js';

const ENV_MODULE = '../src/config/env.js';

function fixtureRecord(overrides: Partial<LegacyRunRecord> = {}): LegacyRunRecord {
  return {
    id: 'run-1',
    testFile: 'senaryo-run-1.spec.ts',
    status: 'passed',
    browser: 'chromium',
    duration: 4.2,
    createdAt: '2026-01-01T00:00:00.000Z',
    message: 'Senaryo başarıyla tamamlandı.',
    exitCode: 0,
    ...overrides,
  };
}

describe('TestRunStore', () => {
  let tmpDir: string;
  let runsDir: string;
  let artifactsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'test-runs-'));
    // RUNS_DIR bilerek henüz VAR OLMAYAN bir alt klasör olarak veriliyor — TestRunStore.persist()
    // klasörü kendi (mkdir recursive) oluşturmalı; store'un "klasör önceden var olmalı" gibi bir
    // varsayım yapmadığını doğrulamak için.
    runsDir = path.join(tmpDir, 'runs-subdir');
    artifactsDir = path.join(tmpDir, 'artifacts-subdir');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.doUnmock(ENV_MODULE);
    vi.resetModules();
  });

  async function loadStore() {
    vi.doMock(ENV_MODULE, () => ({ env: baseEnv({ RUNS_DIR: runsDir, ARTIFACTS_DIR: artifactsDir }) }));
    const mod = await import('../src/core/legacy/TestRunStore.js');
    return mod.TestRunStore;
  }

  it('list(): index dosyası henüz yoksa boş dizi döner (fırlatmaz)', async () => {
    const TestRunStore = await loadStore();
    const store = new TestRunStore();

    await expect(store.list()).resolves.toEqual([]);
  });

  it('append(): kaydı diske yazar ve klasörü (henüz yoksa) kendi oluşturur', async () => {
    const TestRunStore = await loadStore();
    const store = new TestRunStore();

    await store.append(fixtureRecord());

    expect(existsSync(path.join(runsDir, 'test-runs-index.json'))).toBe(true);
  });

  it('append(): en yeni kayıt her zaman list()’in başında (unshift, kronolojik tersine sıralı) döner', async () => {
    const TestRunStore = await loadStore();
    const store = new TestRunStore();

    await store.append(fixtureRecord({ id: 'run-1', createdAt: '2026-01-01T00:00:00.000Z' }));
    await store.append(fixtureRecord({ id: 'run-2', createdAt: '2026-01-02T00:00:00.000Z' }));
    await store.append(fixtureRecord({ id: 'run-3', createdAt: '2026-01-03T00:00:00.000Z' }));

    const all = await store.list();

    expect(all.map((r) => r.id)).toEqual(['run-3', 'run-2', 'run-1']);
  });

  it('failed bir koşumun error/errorOutput alanlarını olduğu gibi korur', async () => {
    const TestRunStore = await loadStore();
    const store = new TestRunStore();

    await store.append(
      fixtureRecord({
        id: 'run-fail',
        status: 'failed',
        exitCode: 1,
        error: 'ambiguous_step: güven=0.30',
        errorOutput: 'Adım 3 hatası: element bulunamadı',
      }),
    );

    const [record] = await store.list();
    expect(record?.status).toBe('failed');
    expect(record?.error).toContain('ambiguous_step');
    expect(record?.errorOutput).toContain('element bulunamadı');
  });

  it('delete(): kaydı index.json\'dan kaldırır, ilişkili detay dosyasını (RUNS_DIR/<id>.json) ve artefakt klasörünü (ARTIFACTS_DIR/<id>/) da diskten siler', async () => {
    const TestRunStore = await loadStore();
    const store = new TestRunStore();

    await store.append(fixtureRecord({ id: 'run-1' }));
    await store.append(fixtureRecord({ id: 'run-2' }));

    // RunLogger'ın yazdığı detay dosyasını ve AgentLoop'un oluşturduğu artefakt klasörünü simüle et.
    const detailPath = path.join(runsDir, 'run-1.json');
    writeFileSync(detailPath, JSON.stringify({ runId: 'run-1' }), 'utf-8');
    const artifactRunDir = path.join(artifactsDir, 'run-1');
    mkdirSync(artifactRunDir, { recursive: true });
    writeFileSync(path.join(artifactRunDir, 'screenshot.png'), 'fake-png-bytes', 'utf-8');

    await store.delete('run-1');

    const remaining = await store.list();
    expect(remaining.map((r) => r.id)).toEqual(['run-2']);
    expect(existsSync(detailPath)).toBe(false);
    expect(existsSync(artifactRunDir)).toBe(false);
  });

  it('delete(): detay dosyası/artefakt klasörü hiç yoksa (run hiç artefakt üretmediyse) yine de başarılı olur', async () => {
    const TestRunStore = await loadStore();
    const store = new TestRunStore();

    await store.append(fixtureRecord({ id: 'run-1' }));

    await expect(store.delete('run-1')).resolves.toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('delete(): var olmayan bir id verilirse NotFoundError fırlatır (index.json\'a hiç dokunmaz)', async () => {
    const TestRunStore = await loadStore();
    const { NotFoundError } = await import('../src/domain/errors.js');
    const store = new TestRunStore();

    await store.append(fixtureRecord({ id: 'run-1' }));

    await expect(store.delete('bilinmeyen-id')).rejects.toBeInstanceOf(NotFoundError);
    expect(await store.list()).toHaveLength(1);
  });

  it('clear(): TÜM kayıtları ve bunlara ait detay dosyalarını/artefakt klasörlerini siler, silinen kayıt sayısını döner', async () => {
    const TestRunStore = await loadStore();
    const store = new TestRunStore();

    await store.append(fixtureRecord({ id: 'run-1' }));
    await store.append(fixtureRecord({ id: 'run-2' }));
    await store.append(fixtureRecord({ id: 'run-3' }));

    const detailPath = path.join(runsDir, 'run-2.json');
    writeFileSync(detailPath, JSON.stringify({ runId: 'run-2' }), 'utf-8');

    const count = await store.clear();

    expect(count).toBe(3);
    expect(await store.list()).toEqual([]);
    expect(existsSync(detailPath)).toBe(false);
  });

  it('clear(): hiç kayıt yoksa 0 döner ve fırlatmaz', async () => {
    const TestRunStore = await loadStore();
    const store = new TestRunStore();

    await expect(store.clear()).resolves.toBe(0);
  });
});
