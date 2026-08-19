import { createHash } from 'node:crypto';
import type { Frame, Page } from 'playwright';
import type { DiscoveredElement, PageSnapshot, RunOptions } from '../../domain/types.js';
import { runDiscovery } from './browserDiscoveryScript.js';
import { createLogger } from '../../config/logger.js';

const log = createLogger('DomAnalyzer');

/** ref -> bu elementi bulmak için kullanılacak Playwright Locator bilgisi. */
export interface ElementHandleRef {
  ref: string;
  frame: Frame;
  selector: string;
}

export interface AnalyzeResult {
  snapshot: PageSnapshot;
  registry: Map<string, ElementHandleRef>;
}

/**
 * DomAnalyzer, sayfanın (ve tüm frame'lerinin, açık shadow DOM dahil) canlı DOM yapısını
 * tarar, etkileşime uygun elementleri keşfeder ve her birine kararlı bir referans (ör. "e3") atar.
 * LLM'e asla ham CSS selector / XPath göstermez; sadece bu referanslar gösterilir.
 */
export class DomAnalyzer {
  async analyze(page: Page, options: RunOptions): Promise<AnalyzeResult> {
    const registry = new Map<string, ElementHandleRef>();
    const elements: DiscoveredElement[] = [];
    const alerts: string[] = [];
    const seenAlertText = new Set<string>();
    let totalDiscovered = 0;
    let startIndex = 1;

    const frames = page.frames();

    for (const frame of frames) {
      if (frame.isDetached()) continue;

      let frameLabel: string;
      try {
        frameLabel = frame === page.mainFrame() ? 'main' : frame.name() || new URL(frame.url()).hostname || 'iframe';
      } catch {
        frameLabel = 'iframe';
      }

      try {
        const remaining = Math.max(0, options.maxElementsPerStep - elements.length);
        if (remaining === 0) break;

        const result = await frame.evaluate(runDiscovery, {
          startIndex,
          maxElements: remaining,
        });

        // Teşhis amaçlı: bir sayfada element bulunamama sorunlarını ayırt etmek için — CSS
        // seçiciyle HİÇ aday bulunamadı mı (sayfa henüz render olmamış / farklı bir yapı) yoksa
        // adaylar bulundu ama görünürlük filtresi mi hepsini eledi (headless render sorunu)?
        // Normal çalışmada gürültü yapmaması için 'debug' seviyesinde (LOG_LEVEL=debug ile açılır).
        log.debug(
          {
            frame: frameLabel,
            frameUrl: (() => {
              try {
                return frame.url();
              } catch {
                return 'bilinmiyor';
              }
            })(),
            totalCandidates: result.totalCandidates,
            returnedElements: result.elements.length,
          },
          'DOM taraması tamamlandı',
        );

        totalDiscovered += result.totalCandidates;
        startIndex = result.nextIndex;

        for (const raw of result.elements) {
          elements.push({
            ref: raw.ref,
            tag: raw.tag,
            role: raw.role,
            accessibleName: raw.accessibleName,
            text: raw.text,
            attributes: raw.attributes,
            visible: raw.visible,
            enabled: raw.enabled,
            frame: frameLabel,
            currentValue: raw.currentValue,
            options: raw.options,
          });
          registry.set(raw.ref, {
            ref: raw.ref,
            frame,
            selector: `[data-ai-ref="${raw.ref}"]`,
          });
        }

        // Frame'ler arası birikimli topla (aynı mesaj birden fazla frame'de tekrar edebilir —
        // metne göre dedupe ediyoruz), toplam gürültüyü sınırlamak için üst limit uyguluyoruz.
        for (const text of result.alerts) {
          if (alerts.length >= 5) break;
          if (seenAlertText.has(text)) continue;
          seenAlertText.add(text);
          alerts.push(text);
        }
      } catch (err) {
        // Cross-origin ya da henüz yüklenmemiş frame'lerde evaluate başarısız olabilir; bu ölümcül
        // değil, sadece o frame'i atlıyoruz. BİLİNÇLİ OLARAK 'warn' seviyesinde tutuluyor (normal
        // "beklenen" durumlar için biraz gürültülü olsa da): daha önce, enjekte edilen betikte
        // gerçek bir hata (örn. tsx/esbuild'in "__name is not defined" sorunu) olduğunda bu catch
        // bloğu sessizce (debug seviyesinde, görünmeden) yutuyordu ve element keşfinin NEDEN hep
        // boş döndüğünü teşhis etmek çok zaman aldı. Gerçek hatalar artık burada görünür kalıyor.
        log.warn({ err, errMessage: err instanceof Error ? err.message : String(err), frame: frameLabel }, 'frame DOM taraması atlandı');
      }
    }

    const url = page.url();
    const title = await page.title().catch(() => '');

    // Teşhis amaçlı: LLM'e GERÇEKTEN gönderilen element listesinin ne olduğunu ("Hesabım"/"Giriş
    // Yap" gibi belirli bir element neden listede yok?" tarzı sorulara doğrudan cevap verebilmek
    // için) burada özetliyoruz. 'debug' seviyesinde olduğundan normal çalışmada görünmez; sadece
    // LOG_LEVEL=debug ile açılır. Secret DEĞERLERİ burada asla olamaz (LLM'e giden aynı veri,
    // secret değerleri element metninde/attribute'larında görünmez).
    log.debug(
      {
        url,
        totalElements: elements.length,
        elements: elements.map((e) => ({
          ref: e.ref,
          tag: e.tag,
          role: e.role,
          name: e.accessibleName,
          text: e.text,
          frame: e.frame,
        })),
        alerts,
      },
      'LLM\'e gönderilecek element listesi',
    );

    const snapshot: PageSnapshot = {
      url,
      title,
      elements,
      totalDiscovered,
      stateHash: computeStateHash(url, elements),
      alerts,
    };

    return { snapshot, registry };
  }
}

function computeStateHash(url: string, elements: DiscoveredElement[]): string {
  const signature = elements
    .map((e) => `${e.ref}:${e.tag}:${e.role}:${e.accessibleName ?? ''}:${e.currentValue ?? ''}`)
    .join('|');
  return createHash('sha1').update(url).update('::').update(signature).digest('hex').slice(0, 16);
}
