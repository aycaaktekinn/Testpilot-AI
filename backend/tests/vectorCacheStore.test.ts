import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PageSnapshot } from '../src/domain/types.js';

/**
 * NOT: hem "@zilliz/milvus2-sdk-node" (gercek Milvus baglantisi acmasin) hem de
 * "../src/core/vectorcache/EmbeddingClient.js" (gercek Ollama HTTP cagrisi yapmasin) mock'lanir —
 * bu test dosyasi SADECE VectorCacheStore'un kendi orkestrasyon mantigini (koleksiyon lazy
 * olusturma, insert cagrisi, hata yayma) dogrular.
 */
describe('VectorCacheStore', () => {
  let hasCollectionMock: ReturnType<typeof vi.fn>;
  let createCollectionMock: ReturnType<typeof vi.fn>;
  let createIndexMock: ReturnType<typeof vi.fn>;
  let loadCollectionSyncMock: ReturnType<typeof vi.fn>;
  let insertMock: ReturnType<typeof vi.fn>;
  let searchMock: ReturnType<typeof vi.fn>;
  let embedMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    hasCollectionMock = vi.fn().mockResolvedValue({ value: false });
    createCollectionMock = vi.fn().mockResolvedValue({});
    createIndexMock = vi.fn().mockResolvedValue({});
    loadCollectionSyncMock = vi.fn().mockResolvedValue({});
    insertMock = vi.fn().mockResolvedValue({ status: { error_code: 'Success' } });
    searchMock = vi.fn().mockResolvedValue({ results: [] });
    embedMock = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);

    vi.doMock('@zilliz/milvus2-sdk-node', () => ({
      MilvusClient: vi.fn().mockImplementation(() => ({
        hasCollection: hasCollectionMock,
        createCollection: createCollectionMock,
        createIndex: createIndexMock,
        loadCollectionSync: loadCollectionSyncMock,
        insert: insertMock,
        search: searchMock,
      })),
      DataType: { Int64: 'Int64', FloatVector: 'FloatVector', VarChar: 'VarChar' },
    }));

    vi.doMock('../src/core/vectorcache/EmbeddingClient.js', () => ({
      EmbeddingClient: vi.fn().mockImplementation(() => ({
        embed: embedMock,
      })),
    }));
  });

  afterEach(() => {
    vi.doUnmock('@zilliz/milvus2-sdk-node');
    vi.doUnmock('../src/core/vectorcache/EmbeddingClient.js');
    vi.resetModules();
  });

  async function loadStore() {
    const { VectorCacheStore } = await import('../src/core/vectorcache/VectorCacheStore.js');
    return new VectorCacheStore('http://localhost:19530', 'http://localhost:11434', 'test-model');
  }

  function fakeSnapshot(): PageSnapshot {
    return {
      url: 'https://example.com/login',
      title: 'Login',
      elements: [],
      totalDiscovered: 0,
      stateHash: 'h1',
      alerts: [],
    };
  }

  function fakeMetadata() {
    return {
      action: 'click',
      targetTag: 'button',
      targetRole: 'button',
      targetAccessibleName: 'Giris Yap',
      domain: 'example.com',
      sourceRunId: 'run-1',
    };
  }

  it('koleksiyon yoksa ilk yazmada olusturur, index ekler ve yukler', async () => {
    const store = await loadStore();

    await store.recordDecision({ scenario: 'test', snapshot: fakeSnapshot(), stepIndex: 0 }, fakeMetadata());

    expect(hasCollectionMock).toHaveBeenCalledTimes(1);
    expect(createCollectionMock).toHaveBeenCalledTimes(1);
    expect(createIndexMock).toHaveBeenCalledTimes(1);
    expect(loadCollectionSyncMock).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledTimes(1);

    const insertArgs = insertMock.mock.calls[0]?.[0];
    expect(insertArgs.data[0].vector).toEqual([0.1, 0.2, 0.3]);
    expect(insertArgs.data[0].action).toBe('click');
  });

  it('koleksiyon zaten varsa tekrar olusturmaya calismaz', async () => {
    hasCollectionMock.mockResolvedValue({ value: true });
    const store = await loadStore();

    await store.recordDecision({ scenario: 'test', snapshot: fakeSnapshot(), stepIndex: 0 }, fakeMetadata());

    expect(createCollectionMock).not.toHaveBeenCalled();
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it('ikinci yazmada koleksiyon tekrar kontrol edilmez (sonuc once cache edilir)', async () => {
    const store = await loadStore();
    const metadata = fakeMetadata();

    await store.recordDecision({ scenario: 'a', snapshot: fakeSnapshot(), stepIndex: 0 }, metadata);
    await store.recordDecision({ scenario: 'b', snapshot: fakeSnapshot(), stepIndex: 1 }, metadata);

    expect(hasCollectionMock).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledTimes(2);
  });

  it('insert basarisiz donerse hata firlatir', async () => {
    insertMock.mockResolvedValue({ status: { error_code: 'UnexpectedError', reason: 'boom' } });
    const store = await loadStore();

    await expect(
      store.recordDecision({ scenario: 'test', snapshot: fakeSnapshot(), stepIndex: 0 }, fakeMetadata()),
    ).rejects.toThrow(/Milvus insert/);
  });

  it('embedding hatasi olursa Milvusa hic yazmaya calismaz', async () => {
    embedMock.mockRejectedValue(new Error('ollama down'));
    const store = await loadStore();

    await expect(
      store.recordDecision({ scenario: 'test', snapshot: fakeSnapshot(), stepIndex: 0 }, fakeMetadata()),
    ).rejects.toThrow('ollama down');

    expect(insertMock).not.toHaveBeenCalled();
    expect(hasCollectionMock).not.toHaveBeenCalled();
  });

  it('koleksiyon olusturma basarisiz olursa bir sonraki cagri tekrar dener', async () => {
    createCollectionMock.mockRejectedValueOnce(new Error('milvus gecici olarak erisilemez'));
    const store = await loadStore();

    await expect(
      store.recordDecision({ scenario: 'test', snapshot: fakeSnapshot(), stepIndex: 0 }, fakeMetadata()),
    ).rejects.toThrow('milvus gecici olarak erisilemez');

    // Ikinci deneme basarili olmali (createCollectionMock artik varsayilan resolved donuse doner).
    await store.recordDecision({ scenario: 'test', snapshot: fakeSnapshot(), stepIndex: 0 }, fakeMetadata());

    expect(hasCollectionMock).toHaveBeenCalledTimes(2);
    expect(createCollectionMock).toHaveBeenCalledTimes(2);
  });

  describe('recordDecision — yazma oncesi tekrar (dedup) kontrolu (v2.1)', () => {
    it('neredeyse birebir ayni bir kayit zaten varsa (ayni action+value) tekrar yazmaz', async () => {
      hasCollectionMock.mockResolvedValue({ value: true });
      searchMock.mockResolvedValue({
        results: [{ action: 'click', value: '', score: 0.999 }],
      });
      const store = await loadStore();

      await store.recordDecision({ scenario: 'test', snapshot: fakeSnapshot(), stepIndex: 0 }, fakeMetadata());

      expect(searchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          vector: [0.1, 0.2, 0.3],
          limit: 1,
          metric_type: 'COSINE',
          filter: 'domain == "example.com"',
        }),
      );
      expect(insertMock).not.toHaveBeenCalled();
    });

    it('benzerlik esigin altindaysa (farkli durum) normal sekilde yazar', async () => {
      hasCollectionMock.mockResolvedValue({ value: true });
      searchMock.mockResolvedValue({
        results: [{ action: 'click', value: '', score: 0.5 }],
      });
      const store = await loadStore();

      await store.recordDecision({ scenario: 'test', snapshot: fakeSnapshot(), stepIndex: 0 }, fakeMetadata());

      expect(insertMock).toHaveBeenCalledTimes(1);
    });

    it('benzerlik yuksek olsa da value farkliysa (ör. farkli arama terimi) tekrar sayilmaz, yazar', async () => {
      hasCollectionMock.mockResolvedValue({ value: true });
      searchMock.mockResolvedValue({
        results: [{ action: 'fill', value: 'laptop', score: 0.999 }],
      });
      const store = await loadStore();

      await store.recordDecision(
        { scenario: 'test', snapshot: fakeSnapshot(), stepIndex: 0 },
        { ...fakeMetadata(), action: 'fill', value: 'laptop kilifi' },
      );

      expect(insertMock).toHaveBeenCalledTimes(1);
    });

    it('koleksiyon ilk kez olusturuluyorsa (henuz hic satir yok) dedup aramasi bos doner, normal yazar', async () => {
      hasCollectionMock.mockResolvedValue({ value: false });
      searchMock.mockResolvedValue({ results: [] });
      const store = await loadStore();

      await store.recordDecision({ scenario: 'test', snapshot: fakeSnapshot(), stepIndex: 0 }, fakeMetadata());

      expect(insertMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('findSimilar (v2.0 Faz 2 — okuma tarafi)', () => {
    it('koleksiyon hic yoksa arama denemeden bos dizi doner (embed dahi cagrilmaz)', async () => {
      hasCollectionMock.mockResolvedValue({ value: false });
      const store = await loadStore();

      const results = await store.findSimilar({ scenario: 'test', snapshot: fakeSnapshot(), stepIndex: 0 }, 5);

      expect(results).toEqual([]);
      expect(embedMock).not.toHaveBeenCalled();
      expect(searchMock).not.toHaveBeenCalled();
    });

    it('koleksiyon varsa domain filtresiyle arar ve sonuclari benzerlik skoruyla esler', async () => {
      hasCollectionMock.mockResolvedValue({ value: true });
      searchMock.mockResolvedValue({
        results: [
          {
            action: 'click',
            target_tag: 'button',
            target_role: 'button',
            target_accessible_name: 'Giris Yap',
            value: '',
            domain: 'example.com',
            source_run_id: 'run-1',
            score: 0.95,
          },
        ],
      });
      const store = await loadStore();

      const results = await store.findSimilar({ scenario: 'test', snapshot: fakeSnapshot(), stepIndex: 0 }, 5);

      expect(searchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          vector: [0.1, 0.2, 0.3],
          limit: 5,
          metric_type: 'COSINE',
          filter: 'domain == "example.com"',
        }),
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        action: 'click',
        targetTag: 'button',
        targetRole: 'button',
        targetAccessibleName: 'Giris Yap',
        value: undefined,
        similarity: 0.95,
      });
    });

    it('score alani eksikse distance alanina, o da yoksa 0a duser', async () => {
      hasCollectionMock.mockResolvedValue({ value: true });
      searchMock.mockResolvedValue({
        results: [
          { action: 'click', target_tag: 'button', distance: 0.7 },
          { action: 'click', target_tag: 'button' },
        ],
      });
      const store = await loadStore();

      const results = await store.findSimilar({ scenario: 'test', snapshot: fakeSnapshot(), stepIndex: 0 }, 5);

      expect(results[0]?.similarity).toBe(0.7);
      expect(results[1]?.similarity).toBe(0);
    });

    it('bos deger ("") value alanini undefined olarak dondurur', async () => {
      hasCollectionMock.mockResolvedValue({ value: true });
      searchMock.mockResolvedValue({
        results: [{ action: 'fill', target_tag: 'input', value: '', score: 0.9 }],
      });
      const store = await loadStore();

      const results = await store.findSimilar({ scenario: 'test', snapshot: fakeSnapshot(), stepIndex: 0 }, 5);

      expect(results[0]?.value).toBeUndefined();
    });

    it('arama hatasi olursa (embedding ya da Milvus) hatayi oldugu gibi yukari firlatir', async () => {
      hasCollectionMock.mockResolvedValue({ value: true });
      searchMock.mockRejectedValue(new Error('milvus arama basarisiz'));
      const store = await loadStore();

      await expect(
        store.findSimilar({ scenario: 'test', snapshot: fakeSnapshot(), stepIndex: 0 }, 5),
      ).rejects.toThrow('milvus arama basarisiz');
    });
  });
});
