import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmbeddingClient } from '../src/core/vectorcache/EmbeddingClient.js';

describe('EmbeddingClient', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('basarili yanitta embedding dizisini dondurur', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
    }) as unknown as typeof fetch;

    const client = new EmbeddingClient('http://localhost:11434', 'test-model');
    const vector = await client.embed('merhaba dunya');

    expect(vector).toEqual([0.1, 0.2, 0.3]);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:11434/api/embeddings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'test-model', prompt: 'merhaba dunya' }),
      }),
    );
  });

  it('taban URLdeki sondaki egik cizgiyi temizler', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: [1] }),
    }) as unknown as typeof fetch;

    const client = new EmbeddingClient('http://localhost:11434/', 'test-model');
    await client.embed('x');

    expect(global.fetch).toHaveBeenCalledWith('http://localhost:11434/api/embeddings', expect.anything());
  });

  it('HTTP hatasi durumunda acik bir hata firlatir (model indirilmemis olabilir mesaji)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'model not found',
    }) as unknown as typeof fetch;

    const client = new EmbeddingClient('http://localhost:11434', 'missing-model');

    await expect(client.embed('x')).rejects.toThrow(/ollama pull missing-model/i);
  });

  it('bos/eksik embedding alani icin hata firlatir', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const client = new EmbeddingClient('http://localhost:11434', 'test-model');

    await expect(client.embed('x')).rejects.toThrow(/beklenmeyen bir yanıt/i);
  });

  it('ag hatasinda acik bir baglanti hatasi firlatir', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const client = new EmbeddingClient('http://localhost:11434', 'test-model');

    await expect(client.embed('x')).rejects.toThrow(/bağlanılamadı/i);
  });

  it('zaman asiminda acik bir zaman asimi hatasi firlatir (parametre verilmezse varsayilan 20000ms)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    global.fetch = vi.fn().mockRejectedValue(abortError) as unknown as typeof fetch;

    const client = new EmbeddingClient('http://localhost:11434', 'test-model');

    await expect(client.embed('x')).rejects.toThrow(/yanıt vermedi/i);
    await expect(client.embed('x')).rejects.toThrow(/20000ms/);
  });

  it('ozel bir timeoutMs verilirse (v2.3 — VECTOR_CACHE_EMBED_TIMEOUT_MS) hata mesaji ve setTimeout suresi bunu kullanir', async () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    global.fetch = vi.fn().mockRejectedValue(abortError) as unknown as typeof fetch;

    const client = new EmbeddingClient('http://localhost:11434', 'test-model', 60_000);

    await expect(client.embed('x')).rejects.toThrow(/60000ms/);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);

    setTimeoutSpy.mockRestore();
  });
});
