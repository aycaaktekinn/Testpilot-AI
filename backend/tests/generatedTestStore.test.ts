import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { baseEnv } from './helpers/fakeEnv.js';
import type { LegacyGeneratedTestMeta } from '../src/domain/legacyTypes.js';

const ENV_MODULE = '../src/config/env.js';

function fixtureMeta(overrides: Partial<LegacyGeneratedTestMeta> = {}): LegacyGeneratedTestMeta {
  return {
    fileName: 'ornek-senaryo-run123.spec.ts',
    createdAt: '2026-01-01T00:00:00.000Z',
    url: 'https://example.com',
    scenario: 'Ana sayfayı ziyaret et',
    variables: {},
    browser: 'chromium',
    headed: true,
    screenshot: false,
    video: false,
    trace: false,
    ...overrides,
  };
}

describe('GeneratedTestStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'generated-tests-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.doUnmock(ENV_MODULE);
    vi.resetModules();
  });

  async function loadStore() {
    vi.doMock(ENV_MODULE, () => ({ env: baseEnv({ GENERATED_TESTS_DIR: tmpDir }) }));
    const mod = await import('../src/core/legacy/GeneratedTestStore.js');
    return { GeneratedTestStore: mod.GeneratedTestStore, buildGeneratedFileName: mod.buildGeneratedFileName };
  }

  it('save() kodu diske .spec.ts olarak yazar ve index.json’a ekler; list() en yeniden en eskiye sıralı döner', async () => {
    const { GeneratedTestStore } = await loadStore();
    const store = new GeneratedTestStore();

    await store.save(fixtureMeta({ fileName: 'birinci-run1.spec.ts', createdAt: '2026-01-01T00:00:00.000Z' }), 'code-1');
    await store.save(fixtureMeta({ fileName: 'ikinci-run2.spec.ts', createdAt: '2026-01-02T00:00:00.000Z' }), 'code-2');

    const all = await store.list();
    expect(all).toHaveLength(2);
    // En son save() edilen en başta olmalı (unshift).
    expect(all[0]?.fileName).toBe('ikinci-run2.spec.ts');
    expect(all[1]?.fileName).toBe('birinci-run1.spec.ts');

    expect(existsSync(path.join(tmpDir, 'ikinci-run2.spec.ts'))).toBe(true);
    expect(readFileSync(path.join(tmpDir, 'ikinci-run2.spec.ts'), 'utf-8')).toBe('code-2');
  });

  it('getMeta()/getCode() kayıtlı bir dosya için doğru veriyi döner; olmayan dosya için NotFoundError fırlatır', async () => {
    const { GeneratedTestStore } = await loadStore();
    const store = new GeneratedTestStore();
    await store.save(fixtureMeta(), 'const x = 1;');

    const meta = await store.getMeta('ornek-senaryo-run123.spec.ts');
    expect(meta.url).toBe('https://example.com');

    const code = await store.getCode('ornek-senaryo-run123.spec.ts');
    expect(code).toBe('const x = 1;');

    await expect(store.getMeta('hic-yok.spec.ts')).rejects.toThrow(/bulunamadı/);
    await expect(store.getCode('hic-yok.spec.ts')).rejects.toThrow(/bulunamadı/);
  });

  it('delete() hem index kaydını hem diskteki dosyayı kaldırır; kayıtlı olmayan dosya için NotFoundError fırlatır', async () => {
    const { GeneratedTestStore } = await loadStore();
    const store = new GeneratedTestStore();
    await store.save(fixtureMeta(), 'kod');

    await store.delete('ornek-senaryo-run123.spec.ts');

    expect(await store.list()).toHaveLength(0);
    expect(existsSync(path.join(tmpDir, 'ornek-senaryo-run123.spec.ts'))).toBe(false);
    await expect(store.delete('ornek-senaryo-run123.spec.ts')).rejects.toThrow(/bulunamadı/);
  });

  it('delete(): disk dosyası daha önce elle silinmiş olsa bile (index.json kaynak-of-truth) sessizce başarılı olur', async () => {
    const { GeneratedTestStore } = await loadStore();
    const store = new GeneratedTestStore();
    await store.save(fixtureMeta(), 'kod');
    unlinkSync(path.join(tmpDir, 'ornek-senaryo-run123.spec.ts'));

    await expect(store.delete('ornek-senaryo-run123.spec.ts')).resolves.toBeUndefined();
    expect(await store.list()).toHaveLength(0);
  });

  it('clear() tüm kayıtları/dosyaları siler ve silinen sayıyı döner', async () => {
    const { GeneratedTestStore } = await loadStore();
    const store = new GeneratedTestStore();
    await store.save(fixtureMeta({ fileName: 'a-1.spec.ts' }), 'a');
    await store.save(fixtureMeta({ fileName: 'b-2.spec.ts' }), 'b');

    const count = await store.clear();

    expect(count).toBe(2);
    expect(await store.list()).toHaveLength(0);
    expect(existsSync(path.join(tmpDir, 'a-1.spec.ts'))).toBe(false);
    expect(existsSync(path.join(tmpDir, 'b-2.spec.ts'))).toBe(false);
  });

  it('güvensiz (path traversal içeren) dosya adları save/getMeta/getCode/delete’te reddedilir', async () => {
    const { GeneratedTestStore } = await loadStore();
    const store = new GeneratedTestStore();

    await expect(store.save(fixtureMeta({ fileName: '../../etc/passwd.spec.ts' }), 'kod')).rejects.toThrow(
      /Geçersiz dosya adı/,
    );
    await expect(store.getCode('../../etc/passwd.spec.ts')).rejects.toThrow(/Geçersiz dosya adı/);
    await expect(store.delete('../../etc/passwd.spec.ts')).rejects.toThrow(/Geçersiz dosya adı/);
  });

  it('list(): index.json henüz hiç yoksa (ilk kullanım) boş dizi döner, fırlatmaz', async () => {
    const { GeneratedTestStore } = await loadStore();
    const store = new GeneratedTestStore();

    await expect(store.list()).resolves.toEqual([]);
  });

  describe('buildGeneratedFileName', () => {
    it('senaryo metnini küçük harfe çevirip slug’lar ve runId’yi sonuna ekler', async () => {
      const { buildGeneratedFileName } = await loadStore();

      const fileName = buildGeneratedFileName('Login Page Test', 'run123');

      expect(fileName).toBe('login-page-test-run123.spec.ts');
    });

    it('Türkçe aksan işaretlerini kaldırır (ör. ş, ç, ı, ğ, ü, ö)', async () => {
      const { buildGeneratedFileName } = await loadStore();

      const fileName = buildGeneratedFileName('Şifre çok üzücü öğürtü', 'run1');

      expect(fileName).not.toMatch(/[şçığüö]/i);
      expect(fileName.endsWith('-run1.spec.ts')).toBe(true);
    });

    it('boş/anlamsız (yalnızca özel karakter) senaryo için "senaryo" fallback’ını kullanır', async () => {
      const { buildGeneratedFileName } = await loadStore();

      const fileName = buildGeneratedFileName('!!!???', 'run1');

      expect(fileName).toBe('senaryo-run1.spec.ts');
    });

    it('çok uzun senaryo metnini 40 karakterle sınırlar', async () => {
      const { buildGeneratedFileName } = await loadStore();

      const longScenario = 'a'.repeat(200);
      const fileName = buildGeneratedFileName(longScenario, 'run1');
      const slugPart = fileName.replace('-run1.spec.ts', '');

      expect(slugPart.length).toBeLessThanOrEqual(40);
    });
  });
});
