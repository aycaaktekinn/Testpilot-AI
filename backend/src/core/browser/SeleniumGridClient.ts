import { SeleniumGridError } from '../../domain/errors.js';
import { createLogger } from '../../config/logger.js';
import { env } from '../../config/env.js';

const log = createLogger('SeleniumGridClient');

/** Grid hub'a bağlanma/session açma işlemi bu süreden uzun sürerse iptal edilir. */
const SESSION_CREATE_TIMEOUT_MS = 30_000;
/** Session kapatma (release) best-effort'tur; kısa bir sınır yeterlidir. */
const SESSION_DELETE_TIMEOUT_MS = 10_000;

export interface GridSession {
  sessionId: string;
  /** Playwright'ın chromium.connectOverCDP()'ye vereceği CDP WebSocket adresi. */
  cdpUrl: string;
  /**
   * v2.2 — SADECE `env.SELENIUM_GRID_NODE_VNC_MAP`'te bu node için bir eşleme VARSA doludur (bkz.
   * env.ts dosya başı açıklaması) — kullanıcının bu session'ı tarayıcısından CANLI izleyebileceği
   * noVNC adresi (ör. "http://localhost:6081"). Eşleme yoksa (varsayılan) `undefined`'dır — bu
   * durumda run normal şekilde çalışır, sadece canlı izleme linki üretilmez.
   */
  liveViewUrl?: string;
}

/**
 * Bir Selenium Grid 4 hub'ıyla, ham W3C WebDriver REST protokolü üzerinden konuşan küçük bir
 * istemci — herhangi bir "selenium-webdriver" paketi KULLANILMIYOR (bu projenin tek WebDriver
 * ihtiyacı, Grid'in bir node'unda oturum açıp oradan Playwright'ın bağlanabileceği CDP adresini
 * almaktan ibaret; tam bir WebDriver istemcisi gereksiz bir bağımlılık olurdu).
 *
 * AKIŞ: `createSession()` hub'da `POST /session` ile bir Chrome/Chromium session'ı ister. Selenium
 * Grid 4, Chrome/Edge tabanlı node'lar için dönen capabilities içine otomatik olarak `se:cdp`
 * alanını (o SPESİFİK session'ın CDP WebSocket adresi) ekler — BrowserManager bu adresle
 * `chromium.connectOverCDP()` çağırır. Run bittiğinde `deleteSession()` ile `DELETE
 * /session/:id` çağrılıp node Grid havuzuna GERİ BIRAKILMALIDIR; aksi halde node süresiz "meşgul"
 * görünür ve havuzdan asla geri dönmez.
 */
export class SeleniumGridClient {
  constructor(private readonly hubUrl: string) {}

  async createSession(): Promise<GridSession> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SESSION_CREATE_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(this.sessionEndpoint(), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        // W3C WebDriver "New Session" isteği — SADECE Chrome/Chromium isteniyor (bkz. dosya başı
        // açıklaması: Grid'in CDP relay'i, protokol düzeyinde SADECE Chromium-ailesi tarayıcılarda
        // vardır).
        body: JSON.stringify({
          capabilities: {
            alwaysMatch: { browserName: 'chrome' },
          },
        }),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SeleniumGridError(
          `Selenium Grid hub'ı (${this.hubUrl}) ${SESSION_CREATE_TIMEOUT_MS}ms içinde yanıt vermedi. ` +
            'Hub adresi doğru mu ve Grid çalışıyor mu kontrol edin.',
        );
      }
      throw new SeleniumGridError(
        `Selenium Grid hub'ına (${this.hubUrl}) bağlanılamadı: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      log.error({ status: response.status, text }, "Grid hub'ı session isteğini reddetti");
      throw new SeleniumGridError(
        `Selenium Grid hub'ı session isteğini reddetti (HTTP ${response.status}). Grid'de boşta bir Chrome ` +
          `node'u olmayabilir. ${truncate(text, 300)}`,
      );
    }

    const json = (await response.json().catch(() => null)) as GridSessionResponse | null;
    const sessionId = json?.value?.sessionId;
    const cdpUrl = json?.value?.capabilities?.['se:cdp'];

    if (!sessionId) {
      throw new SeleniumGridError("Grid hub'ından geçerli bir sessionId alınamadı (beklenmeyen yanıt şekli).");
    }

    if (!cdpUrl) {
      // Session AÇILDI ama CDP adresi yoksa node'u hemen serbest bırakmalıyız — aksi halde havuzda
      // kalıcı olarak "meşgul" görünen, hiç kullanılamayacak bir session sızdırırız.
      await this.deleteSession(sessionId);
      throw new SeleniumGridError(
        "Grid hub'ı bir session açtı ama CDP adresi (se:cdp) döndürmedi — bu node Chrome/Chromium " +
          'tabanlı olmayabilir veya bu Grid sürümü CDP relay desteklemiyor olabilir.',
      );
    }

    // v2.1 — node'un GERÇEK Docker-içi adresini (host'tan CDP rewrite'ından ÖNCEKİ hali) burada
    // saklıyoruz — v2.2'de noVNC linkini de AYNI node kimliğinden (IP) türetmemiz gerekiyor, ve
    // aşağıdaki rewriteHostInUrl çağrısı `cdpUrl`'ü YERİNDE (in-place) değil, yeni bir string olarak
    // döndürür, yani orijinal IP'yi hâlâ `cdpUrl`'den okuyabiliriz.
    const originalNodeHost = this.extractHostname(cdpUrl);

    const finalCdpUrl = this.rewriteHostInUrl(cdpUrl, env.SELENIUM_GRID_NODE_HOST_MAP, 'SELENIUM_GRID_NODE_HOST_MAP');
    const liveViewUrl = originalNodeHost ? this.computeLiveViewUrl(originalNodeHost) : undefined;

    log.info({ sessionId, liveViewUrl }, "Selenium Grid session'ı açıldı");
    return { sessionId, cdpUrl: finalCdpUrl, liveViewUrl };
  }

  private extractHostname(url: string): string | null {
    try {
      return new URL(url).hostname;
    } catch (err) {
      log.warn({ err, url }, 'Adres ayrıştırılamadı');
      return null;
    }
  }

  /**
   * v2.1 — SADECE `mapEnvValue` (ör. `env.SELENIUM_GRID_NODE_HOST_MAP`) tanımlıysa bir şey yapar
   * (bkz. env.ts dosya başı açıklaması). Grid hub'ının döndürdüğü `se:cdp` adresi, node'un KENDİ
   * Docker-içi bridge network IP'sini içerir (ör. "172.28.0.11:4444") — backend Docker DIŞINDA (bu
   * makinenin üzerinde native) çalıştığında bu IP'ye ULAŞAMAZ.
   *
   * BİLİNÇLİ OLARAK burada `SE_NODE_HOST`/`SE_NODE_PORT`'A GÜVENİLMEZ: node'u doğrudan "localhost"
   * advertise etmesi için ayarlamak GÖRÜNÜŞTE basit bir çözüm gibi dursa da hub'ın KENDİSİNİN node'a
   * ulaşmasını (kayıt/health-check) BOZAR — "localhost" hub'ın kendi container'ından bakıldığında
   * hub'ın KENDİSİNE işaret eder, node'a değil (canlıda doğrulandı: kayıt sonsuz döngüye giriyordu).
   * Bu yüzden node'un kendi Docker-içi adresi HİÇ DEĞİŞTİRİLMEZ (hub-node kaydı bozulmasın diye);
   * bunun yerine bu SADECE İSTEMCİ TARAFINDA (burada, hub'dan yanıt aldıktan SONRA) bilinen sabit bir
   * IP → host portu haritasıyla adresi yeniden yazar — hub-node iletişimini hiç etkilemez.
   *
   * v2.2'de `SELENIUM_GRID_NODE_VNC_MAP` (noVNC linki) için de AYNI mantıkla, ayrı bir çağrıyla
   * kullanılır — bu yüzden hangi env değişkeninin kaynaklandığı (`mapEnvVarName`) sadece log
   * mesajlarında doğru ismi göstermek için parametre olarak alınır.
   */
  private rewriteHostInUrl(url: string, mapEnvValue: string | undefined, mapEnvVarName: string): string {
    if (!mapEnvValue) {
      return url;
    }

    const nodeHost = this.extractHostname(url);
    const replacement = this.lookupReplacement(mapEnvValue, nodeHost, mapEnvVarName);
    if (!replacement) {
      // Harita TANIMLI ama bu node için karşılığı YOKSA sessizce devam ETMİYORUZ — bu, host'tan
      // erişilemeyecek bir adresle bağlanmaya çalışılıp anlaşılması güç bir ECONNREFUSED/ECONNRESET
      // almaktansa, NEDEN başarısız olabileceğini şimdiden loglara yazmak içindir.
      log.warn(
        { nodeHost, mapEnvVarName },
        'Bu node için haritada bir eşleme bulunamadı, adres olduğu gibi kullanılıyor (host makineden erişilemeyebilir)',
      );
      return url;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      log.warn({ err, url }, 'Adres ayrıştırılamadı, olduğu gibi kullanılıyor');
      return url;
    }

    const [replacementHost, replacementPort] = replacement.split(':');
    if (!replacementHost) {
      log.warn({ mapEnvVarName, replacement }, '"host:port" formatında olmalı, adres olduğu gibi kullanılıyor');
      return url;
    }
    parsed.hostname = replacementHost;
    if (replacementPort) {
      parsed.port = replacementPort;
    }

    const rewritten = parsed.toString();
    log.debug({ from: url, to: rewritten }, "Adres host'tan erişilebilir olacak şekilde yeniden yazıldı");
    return rewritten;
  }

  /**
   * v2.2 — hub'dan dönen yanıtta noVNC için bir alan YOKTUR (sadece `se:cdp` vardır) — bu yüzden
   * `rewriteHostInUrl`'ün aksine "var olan bir adresi düzeltme" değil, node'un IP'sinden SIFIRDAN
   * bir http(s) adresi ÜRETME işidir. `env.SELENIUM_GRID_NODE_VNC_MAP`'te bu node için bir eşleme
   * yoksa (varsayılan durum) `undefined` döner — canlı izleme linki üretilmez, run etkilenmez.
   */
  private computeLiveViewUrl(nodeHost: string): string | undefined {
    const replacement = this.lookupReplacement(env.SELENIUM_GRID_NODE_VNC_MAP, nodeHost, 'SELENIUM_GRID_NODE_VNC_MAP');
    return replacement ? `http://${replacement}` : undefined;
  }

  /** `lookupReplacement`: verilen JSON haritada `nodeHost` için bir "host:port" karşılığı arar. */
  private lookupReplacement(mapEnvValue: string | undefined, nodeHost: string | null, mapEnvVarName: string): string | undefined {
    if (!mapEnvValue || !nodeHost) {
      return undefined;
    }

    let map: Record<string, string>;
    try {
      map = JSON.parse(mapEnvValue) as Record<string, string>;
    } catch (err) {
      log.warn({ err, mapEnvVarName }, 'geçerli bir JSON değil, atlanıyor');
      return undefined;
    }

    return map[nodeHost];
  }

  /** Best-effort: node'u Grid havuzuna geri bırakır. Asla fırlatmaz — sadece loglar. */
  async deleteSession(sessionId: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SESSION_DELETE_TIMEOUT_MS);

    try {
      await fetch(this.sessionEndpoint(sessionId), { method: 'DELETE', signal: controller.signal });
      log.info({ sessionId }, "Selenium Grid session'ı serbest bırakıldı");
    } catch (err) {
      log.warn({ err, sessionId }, "Grid session'ı serbest bırakılamadı (node havuzda 'meşgul' kalmış olabilir)");
    } finally {
      clearTimeout(timer);
    }
  }

  private sessionEndpoint(sessionId?: string): string {
    const base = this.hubUrl.replace(/\/+$/, '');
    return sessionId ? `${base}/session/${sessionId}` : `${base}/session`;
  }
}

interface GridSessionResponse {
  value?: {
    sessionId?: string;
    capabilities?: Record<string, string | undefined> & { 'se:cdp'?: string };
  };
}

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}
