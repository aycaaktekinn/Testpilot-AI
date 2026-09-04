import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SeleniumGridClient } from '../src/core/browser/SeleniumGridClient.js';
import { SeleniumGridError } from '../src/domain/errors.js';
import { env } from '../src/config/env.js';

// v2.1/v2.2 — bkz. env.ts SELENIUM_GRID_NODE_HOST_MAP / SELENIUM_GRID_NODE_VNC_MAP dosya başı
// açıklamaları. Testler bu alanları doğrudan mutasyonla değiştirir (mock modülü tek bir paylaşılan
// obje döndürür) — her testten sonra undefined'a resetlenir ki testler birbirini etkilemesin.
//
// v2.3 — DÜZELTME: NODE_ENV/LOG_LEVEL bu mock'ta hiç YOKTU — SeleniumGridClient.ts, `logger.js`'i
// import eder ve o dosya modül yüklenirken (top-level) `pino({ level: env.LOG_LEVEL, ... })` çağırır;
// LOG_LEVEL undefined ise pino "default level:undefined must be included in custom levels" hatasıyla
// FIRLATIR — bu, tek bir testin değil, TÜM dosyanın import anında çökmesine (0 test çalışmadan
// FAIL) yol açıyordu (gerçek makinede `npm test` ile canlı doğrulandı). `LOG_LEVEL: 'silent'`
// diğer test dosyalarındaki (bkz. tests/helpers/fakeEnv.ts baseEnv()) kanonik değerle aynıdır.
vi.mock('../src/config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    SELENIUM_GRID_NODE_HOST_MAP: undefined as string | undefined,
    SELENIUM_GRID_NODE_VNC_MAP: undefined as string | undefined,
  },
}));

const HUB_URL = 'http://grid-hub.local:4444';

function jsonResponse(body: unknown, init: Partial<Response> & { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('SeleniumGridClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    env.SELENIUM_GRID_NODE_HOST_MAP = undefined;
    env.SELENIUM_GRID_NODE_VNC_MAP = undefined;
    vi.restoreAllMocks();
  });

  it('createSession(): başarılı W3C yanıtından sessionId + se:cdp adresini çıkarır', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        value: {
          sessionId: 'sess-123',
          capabilities: { browserName: 'chrome', 'se:cdp': 'ws://node-1:9222/devtools/browser/abc' },
        },
      }),
    );

    const client = new SeleniumGridClient(HUB_URL);
    const session = await client.createSession();

    expect(session).toEqual({ sessionId: 'sess-123', cdpUrl: 'ws://node-1:9222/devtools/browser/abc' });

    // Doğru endpoint'e, doğru W3C "New Session" gövdesiyle istek atılmış olmalı (v3.22/v3.24 —
    // sertifika/güvenlik capability'leri + Java tarafındaki kanıtlanmış Chrome flag'leri dahil;
    // targetUrl verilmediği için --unsafely-treat-insecure-origin-as-secure YOK).
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(`${HUB_URL}/session`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      capabilities: {
        alwaysMatch: {
          browserName: 'chrome',
          acceptInsecureCerts: true,
          'goog:chromeOptions': {
            args: [
              '--ignore-certificate-errors',
              '--ignore-ssl-errors',
              '--allow-insecure-localhost',
              '--allow-running-insecure-content',
              '--disable-notifications',
              '--disable-popup-blocking',
            ],
            excludeSwitches: ['enable-automation'],
          },
        },
      },
    });
  });

  it('v3.24 — createSession(targetUrl): geçerli bir hedef URL verilirse --unsafely-treat-insecure-origin-as-secure=<origin> flag\'i eklenir', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        value: { sessionId: 's1', capabilities: { 'se:cdp': 'ws://node-1:9222/devtools/browser/abc' } },
      }),
    );

    const client = new SeleniumGridClient(HUB_URL);
    await client.createSession('https://vitwebpreprodauto.vakifbank.intra/login?returnUrl=%2F');

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.capabilities.alwaysMatch['goog:chromeOptions'].args).toContain(
      '--unsafely-treat-insecure-origin-as-secure=https://vitwebpreprodauto.vakifbank.intra',
    );
  });

  it('v3.24 — createSession(targetUrl): geçersiz bir URL sessizce yok sayılır (flag eklenmez, fırlatmaz)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({
        value: { sessionId: 's1', capabilities: { 'se:cdp': 'ws://node-1:9222/devtools/browser/abc' } },
      }),
    );

    const client = new SeleniumGridClient(HUB_URL);
    await expect(client.createSession('boyle-bir-url-yok')).resolves.toBeTruthy();

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(
      (body.capabilities.alwaysMatch['goog:chromeOptions'].args as string[]).some((a: string) =>
        a.startsWith('--unsafely-treat-insecure-origin-as-secure'),
      ),
    ).toBe(false);
  });

  it('createSession(): hub sonda "/" ile bitse bile endpoint doğru kurulur', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ value: { sessionId: 's1', capabilities: { 'se:cdp': 'ws://x' } } }),
    );

    const client = new SeleniumGridClient(`${HUB_URL}/`);
    await client.createSession();

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(`${HUB_URL}/session`);
  });

  it('createSession(): hub HTTP hatası dönerse SeleniumGridError fırlatır', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponse({ value: { error: 'session not created' } }, { ok: false, status: 500 }),
    );

    const client = new SeleniumGridClient(HUB_URL);

    await expect(client.createSession()).rejects.toBeInstanceOf(SeleniumGridError);
  });

  it('createSession(): sessionId eksikse (beklenmeyen yanıt şekli) SeleniumGridError fırlatır', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({ value: {} }));

    const client = new SeleniumGridClient(HUB_URL);

    await expect(client.createSession()).rejects.toBeInstanceOf(SeleniumGridError);
  });

  it('createSession(): se:cdp eksikse SeleniumGridError fırlatır VE açılan session\'ı hemen serbest bırakır (DELETE atar)', async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ value: { sessionId: 'orphan-1', capabilities: {} } })) // POST /session
      .mockResolvedValueOnce(jsonResponse({})); // DELETE /session/orphan-1 (best-effort cleanup)

    const client = new SeleniumGridClient(HUB_URL);

    await expect(client.createSession()).rejects.toBeInstanceOf(SeleniumGridError);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [deleteUrl, deleteInit] = fetchMock.mock.calls[1]!;
    expect(deleteUrl).toBe(`${HUB_URL}/session/orphan-1`);
    expect(deleteInit.method).toBe('DELETE');
  });

  it('createSession(): ağ hatasında (fetch reddi) SeleniumGridError fırlatır (fırlatmaz "Error" değil)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const client = new SeleniumGridClient(HUB_URL);

    await expect(client.createSession()).rejects.toBeInstanceOf(SeleniumGridError);
  });

  describe('createSession() — SELENIUM_GRID_NODE_HOST_MAP ile CDP adresi yeniden yazma (v2.1)', () => {
    it('harita tanımlıysa VE node eşleşiyorsa CDP adresini haritadaki host:port ile degistirir', async () => {
      env.SELENIUM_GRID_NODE_HOST_MAP = JSON.stringify({ '172.28.0.11': 'localhost:5561' });
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({
          value: { sessionId: 's1', capabilities: { 'se:cdp': 'ws://172.28.0.11:4444/session/s1/se/cdp' } },
        }),
      );

      const client = new SeleniumGridClient(HUB_URL);
      const session = await client.createSession();

      expect(session.cdpUrl).toBe('ws://localhost:5561/session/s1/se/cdp');
    });

    it('v3.23 — harita tanımlı ama node eşlesmiyorsa VE dönen host Docker bridge IP\'sine benziyorsa, hub\'ın kendi hostuyla (portu koruyarak) yeniden yazar', async () => {
      env.SELENIUM_GRID_NODE_HOST_MAP = JSON.stringify({ '172.28.0.11': 'localhost:5561' });
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({
          value: { sessionId: 's1', capabilities: { 'se:cdp': 'ws://172.28.0.99:4444/session/s1/se/cdp' } },
        }),
      );

      const client = new SeleniumGridClient(HUB_URL);
      const session = await client.createSession();

      // HUB_URL = 'http://grid-hub.local:4444' — host 'grid-hub.local' ile değişti, port (4444) korundu.
      expect(session.cdpUrl).toBe('ws://grid-hub.local:4444/session/s1/se/cdp');
    });

    it('harita gecersiz JSON ise fırlatmaz (v3.23 fallback\'a düşer, Docker bridge IP\'si hub hostuyla değişir)', async () => {
      env.SELENIUM_GRID_NODE_HOST_MAP = '{ gecersiz json';
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({
          value: { sessionId: 's1', capabilities: { 'se:cdp': 'ws://172.28.0.11:4444/session/s1/se/cdp' } },
        }),
      );

      const client = new SeleniumGridClient(HUB_URL);
      const session = await client.createSession();

      expect(session.cdpUrl).toBe('ws://grid-hub.local:4444/session/s1/se/cdp');
    });

    it('v3.23 — harita tanımsızsa (varsayılan) VE dönen host Docker bridge IP\'sine benziyorsa, hub\'ın kendi hostuyla (portu koruyarak) yeniden yazar — bkz. gerçek VakıfBank Grid vakası (uzak sunucu, node 172.18.x.x döndürüyor)', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({
          value: { sessionId: 's1', capabilities: { 'se:cdp': 'ws://172.28.0.11:4444/session/s1/se/cdp' } },
        }),
      );

      const client = new SeleniumGridClient(HUB_URL);
      const session = await client.createSession();

      expect(session.cdpUrl).toBe('ws://grid-hub.local:4444/session/s1/se/cdp');
    });

    it('v3.23 — dönen host Docker bridge IP\'sine BENZEMİYORSA (ör. kurumsal ağda gerçekten erişilebilir bir 10.x/hostname adresi), harita yoksa bile HİÇ dokunulmaz', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({
          value: { sessionId: 's1', capabilities: { 'se:cdp': 'ws://10.30.165.150:4444/session/s1/se/cdp' } },
        }),
      );

      const client = new SeleniumGridClient(HUB_URL);
      const session = await client.createSession();

      expect(session.cdpUrl).toBe('ws://10.30.165.150:4444/session/s1/se/cdp');
    });

    it('v3.23 — node host zaten hub ile aynıysa fallback tekrar yazma yapmaz', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({
          value: { sessionId: 's1', capabilities: { 'se:cdp': 'ws://grid-hub.local:4444/session/s1/se/cdp' } },
        }),
      );

      const client = new SeleniumGridClient(HUB_URL);
      const session = await client.createSession();

      expect(session.cdpUrl).toBe('ws://grid-hub.local:4444/session/s1/se/cdp');
    });
  });

  describe('createSession() — SELENIUM_GRID_NODE_VNC_MAP ile canlı izleme linki (v2.2)', () => {
    it('harita tanımlıysa VE node eşleşiyorsa liveViewUrl "http://host:port" olarak üretilir', async () => {
      env.SELENIUM_GRID_NODE_VNC_MAP = JSON.stringify({ '172.28.0.11': 'localhost:6081' });
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({
          value: { sessionId: 's1', capabilities: { 'se:cdp': 'ws://172.28.0.11:5555/session/s1/se/cdp' } },
        }),
      );

      const client = new SeleniumGridClient(HUB_URL);
      const session = await client.createSession();

      expect(session.liveViewUrl).toBe('http://localhost:6081');
      // CDP adresi bu haritadan (VNC map) ETKİLENMEMELİ — ama SELENIUM_GRID_NODE_HOST_MAP tanımsız
      // olduğu ve dönen host bir Docker bridge IP'sine benzediği için v3.23 fallback'i devreye girer.
      expect(session.cdpUrl).toBe('ws://grid-hub.local:5555/session/s1/se/cdp');
    });

    it('harita tanımsızsa (varsayılan) liveViewUrl hiç üretilmez', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({
          value: { sessionId: 's1', capabilities: { 'se:cdp': 'ws://172.28.0.11:5555/session/s1/se/cdp' } },
        }),
      );

      const client = new SeleniumGridClient(HUB_URL);
      const session = await client.createSession();

      expect(session.liveViewUrl).toBeUndefined();
    });

    it('harita tanımlı ama node eşlesmiyorsa liveViewUrl üretilmez (fırlatmaz)', async () => {
      env.SELENIUM_GRID_NODE_VNC_MAP = JSON.stringify({ '172.28.0.99': 'localhost:6099' });
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({
          value: { sessionId: 's1', capabilities: { 'se:cdp': 'ws://172.28.0.11:5555/session/s1/se/cdp' } },
        }),
      );

      const client = new SeleniumGridClient(HUB_URL);
      const session = await client.createSession();

      expect(session.liveViewUrl).toBeUndefined();
    });

    it('CDP host haritası VE VNC haritası aynı anda çalışır, birbirini etkilemez', async () => {
      env.SELENIUM_GRID_NODE_HOST_MAP = JSON.stringify({ '172.28.0.11': 'localhost:5561' });
      env.SELENIUM_GRID_NODE_VNC_MAP = JSON.stringify({ '172.28.0.11': 'localhost:6081' });
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse({
          value: { sessionId: 's1', capabilities: { 'se:cdp': 'ws://172.28.0.11:5555/session/s1/se/cdp' } },
        }),
      );

      const client = new SeleniumGridClient(HUB_URL);
      const session = await client.createSession();

      expect(session.cdpUrl).toBe('ws://localhost:5561/session/s1/se/cdp');
      expect(session.liveViewUrl).toBe('http://localhost:6081');
    });
  });

  it('deleteSession(): başarılı DELETE isteği atar', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(jsonResponse({}));

    const client = new SeleniumGridClient(HUB_URL);
    await client.deleteSession('sess-123');

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe(`${HUB_URL}/session/sess-123`);
    expect(init.method).toBe('DELETE');
  });

  it('deleteSession(): fetch reddederse best-effort\'tür — ASLA fırlatmaz', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('node zaten kapandı'));

    const client = new SeleniumGridClient(HUB_URL);

    await expect(client.deleteSession('sess-123')).resolves.toBeUndefined();
  });
});
