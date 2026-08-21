import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseEnv } from './helpers/fakeEnv.js';
import type { RunOptions } from '../src/domain/types.js';
import type { DiscoveryResult } from '../src/core/dom/browserDiscoveryScript.js';

const ENV_MODULE = '../src/config/env.js';

vi.doMock(ENV_MODULE, () => ({ env: baseEnv() }));
const { DomAnalyzer } = await import('../src/core/dom/DomAnalyzer.js');

afterEach(() => {
  vi.clearAllMocks();
});

function fakeOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    maxSteps: 10,
    headless: true,
    stepTimeoutMs: 5000,
    navigationTimeoutMs: 5000,
    defaultActionTimeoutMs: 3000,
    maxElementsPerStep: 80,
    maxRepeatedActions: 3,
    minConfidence: 0.5,
    viewport: { width: 1024, height: 768 },
    browserEngine: 'chromium',
    captureScreenshot: false,
    captureVideo: false,
    captureTrace: false,
    useSeleniumGrid: false,
    ...overrides,
  };
}

function discoveryResult(overrides: Partial<DiscoveryResult> = {}): DiscoveryResult {
  return {
    elements: [],
    totalCandidates: 0,
    nextIndex: 1,
    alerts: [],
    ...overrides,
  };
}

function rawElement(ref: string, overrides: Record<string, unknown> = {}) {
  return {
    ref,
    tag: 'button',
    role: 'button',
    accessibleName: 'Gönder',
    text: 'Gönder',
    attributes: {},
    visible: true,
    enabled: true,
    inViewport: true,
    ...overrides,
  };
}

function createFakeFrame(opts: {
  name?: string;
  url?: string;
  isDetached?: boolean;
  evaluateResult?: DiscoveryResult;
  evaluateImpl?: () => Promise<DiscoveryResult>;
}) {
  return {
    isDetached: vi.fn().mockReturnValue(opts.isDetached ?? false),
    name: vi.fn().mockReturnValue(opts.name ?? ''),
    url: vi.fn().mockReturnValue(opts.url ?? 'https://example.com'),
    evaluate: opts.evaluateImpl ? vi.fn(opts.evaluateImpl) : vi.fn().mockResolvedValue(opts.evaluateResult ?? discoveryResult()),
  };
}

function createFakePage(opts: { frames: ReturnType<typeof createFakeFrame>[]; mainFrame: ReturnType<typeof createFakeFrame>; url?: string; title?: string }) {
  return {
    frames: vi.fn().mockReturnValue(opts.frames),
    mainFrame: vi.fn().mockReturnValue(opts.mainFrame),
    url: vi.fn().mockReturnValue(opts.url ?? 'https://example.com'),
    title: vi.fn().mockResolvedValue(opts.title ?? 'Test Sayfası'),
  };
}

describe('DomAnalyzer.analyze', () => {
  it('ana frame’deki elementleri frame="main" olarak toplar ve her ref için registry’de doğru selector’ı oluşturur', async () => {
    const mainFrame = createFakeFrame({ evaluateResult: discoveryResult({ elements: [rawElement('e1'), rawElement('e2')], totalCandidates: 2, nextIndex: 3 }) });
    const page = createFakePage({ frames: [mainFrame], mainFrame });
    const analyzer = new DomAnalyzer();

    const { snapshot, registry } = await analyzer.analyze(page as never, fakeOptions());

    expect(snapshot.elements).toHaveLength(2);
    expect(snapshot.elements.every((e) => e.frame === 'main')).toBe(true);
    expect(registry.get('e1')?.selector).toBe('[data-ai-ref="e1"]');
    expect(registry.get('e2')).toBeDefined();
  });

  it('bir <select> elementinin "options" listesini (browserDiscoveryScript.ts’ten gelen ham veriyi) snapshot’a aynen taşır (hepsiburada.com "sırala" regresyon koruması)', async () => {
    const options = ['Önerilen sıralama', 'En düşük fiyat', 'En yüksek fiyat'];
    const mainFrame = createFakeFrame({
      evaluateResult: discoveryResult({
        elements: [rawElement('e9', { tag: 'select', role: 'combobox', accessibleName: null, currentValue: 'Önerilen sıralama', options })],
      }),
    });
    const page = createFakePage({ frames: [mainFrame], mainFrame });
    const analyzer = new DomAnalyzer();

    const { snapshot } = await analyzer.analyze(page as never, fakeOptions());

    expect(snapshot.elements[0]?.options).toEqual(options);
  });

  it('"options" alanı olmayan (select dışı) elementlerde snapshot’taki options undefined kalır', async () => {
    const mainFrame = createFakeFrame({ evaluateResult: discoveryResult({ elements: [rawElement('e1')] }) });
    const page = createFakePage({ frames: [mainFrame], mainFrame });
    const analyzer = new DomAnalyzer();

    const { snapshot } = await analyzer.analyze(page as never, fakeOptions());

    expect(snapshot.elements[0]?.options).toBeUndefined();
  });

  it('iframe’de frame.name() doluysa onu, boşsa URL hostname’ini frame etiketi olarak kullanır', async () => {
    const mainFrame = createFakeFrame({ evaluateResult: discoveryResult() });
    const namedIframe = createFakeFrame({ name: 'payment-widget', evaluateResult: discoveryResult({ elements: [rawElement('e1')] }) });
    const unnamedIframe = createFakeFrame({ name: '', url: 'https://payments.example.com/widget', evaluateResult: discoveryResult({ elements: [rawElement('e2')] }) });
    const page = createFakePage({ frames: [mainFrame, namedIframe, unnamedIframe], mainFrame });
    const analyzer = new DomAnalyzer();

    const { snapshot } = await analyzer.analyze(page as never, fakeOptions());

    const named = snapshot.elements.find((e) => e.ref === 'e1');
    const unnamed = snapshot.elements.find((e) => e.ref === 'e2');
    expect(named?.frame).toBe('payment-widget');
    expect(unnamed?.frame).toBe('payments.example.com');
  });

  it('koparılmış (detached) bir frame taranmaz', async () => {
    const mainFrame = createFakeFrame({ evaluateResult: discoveryResult() });
    const detached = createFakeFrame({ isDetached: true, evaluateResult: discoveryResult({ elements: [rawElement('e1')] }) });
    const page = createFakePage({ frames: [mainFrame, detached], mainFrame });
    const analyzer = new DomAnalyzer();

    const { snapshot } = await analyzer.analyze(page as never, fakeOptions());

    expect(detached.evaluate).not.toHaveBeenCalled();
    expect(snapshot.elements).toHaveLength(0);
  });

  it('maxElementsPerStep bütçesi dolunca sonraki frame’ler hiç taranmaz (evaluate çağrılmaz)', async () => {
    const mainFrame = createFakeFrame({ evaluateResult: discoveryResult({ elements: [rawElement('e1')], nextIndex: 2 }) });
    const secondFrame = createFakeFrame({ evaluateResult: discoveryResult({ elements: [rawElement('e2')] }) });
    const page = createFakePage({ frames: [mainFrame, secondFrame], mainFrame });
    const analyzer = new DomAnalyzer();

    const { snapshot } = await analyzer.analyze(page as never, fakeOptions({ maxElementsPerStep: 1 }));

    expect(snapshot.elements).toHaveLength(1);
    expect(secondFrame.evaluate).not.toHaveBeenCalled();
  });

  it('bir frame’in evaluate()’i hata fırlatırsa o frame atlanır, analiz genel olarak çökmez', async () => {
    const mainFrame = createFakeFrame({ evaluateImpl: () => Promise.reject(new Error('cross-origin frame'))});
    const secondFrame = createFakeFrame({ evaluateResult: discoveryResult({ elements: [rawElement('e1')] }) });
    const page = createFakePage({ frames: [mainFrame, secondFrame], mainFrame });
    const analyzer = new DomAnalyzer();

    const { snapshot } = await analyzer.analyze(page as never, fakeOptions());

    expect(snapshot.elements).toHaveLength(1);
    expect(snapshot.elements[0]?.ref).toBe('e1');
  });

  it('startIndex’i frame’ler arası taşır: ikinci frame’in evaluate’i birinci frame’in nextIndex’iyle çağrılır', async () => {
    const mainFrame = createFakeFrame({ evaluateResult: discoveryResult({ elements: [rawElement('e1')], nextIndex: 7 }) });
    const secondFrame = createFakeFrame({ evaluateResult: discoveryResult({ elements: [rawElement('e7')] }) });
    const page = createFakePage({ frames: [mainFrame, secondFrame], mainFrame });
    const analyzer = new DomAnalyzer();

    await analyzer.analyze(page as never, fakeOptions({ maxElementsPerStep: 80 }));

    expect(mainFrame.evaluate).toHaveBeenCalledWith(expect.any(Function), { startIndex: 1, maxElements: 80 });
    expect(secondFrame.evaluate).toHaveBeenCalledWith(expect.any(Function), { startIndex: 7, maxElements: 79 });
  });

  it('alert metinlerini frame’ler arasında metne göre dedupe eder ve en fazla 5 tanesini tutar', async () => {
    const manyAlerts = Array.from({ length: 6 }, (_, i) => `Hata mesajı ${i}`);
    const mainFrame = createFakeFrame({ evaluateResult: discoveryResult({ alerts: manyAlerts }) });
    const secondFrame = createFakeFrame({ evaluateResult: discoveryResult({ alerts: [manyAlerts[0] ?? ''] }) }); // tekrar eden aynı metin
    const page = createFakePage({ frames: [mainFrame, secondFrame], mainFrame });
    const analyzer = new DomAnalyzer();

    const { snapshot } = await analyzer.analyze(page as never, fakeOptions());

    expect(snapshot.alerts).toHaveLength(5);
    expect(new Set(snapshot.alerts).size).toBe(5);
  });

  it('stateHash: aynı URL + aynı elementler için deterministiktir; elementler değişince değişir', async () => {
    const analyzer = new DomAnalyzer();

    const frameA1 = createFakeFrame({ evaluateResult: discoveryResult({ elements: [rawElement('e1', { accessibleName: 'Gönder' })] }) });
    const pageA = createFakePage({ frames: [frameA1], mainFrame: frameA1, url: 'https://example.com' });
    const { snapshot: snapA } = await analyzer.analyze(pageA as never, fakeOptions());

    const frameA2 = createFakeFrame({ evaluateResult: discoveryResult({ elements: [rawElement('e1', { accessibleName: 'Gönder' })] }) });
    const pageA2 = createFakePage({ frames: [frameA2], mainFrame: frameA2, url: 'https://example.com' });
    const { snapshot: snapA2 } = await analyzer.analyze(pageA2 as never, fakeOptions());

    expect(snapA.stateHash).toBe(snapA2.stateHash);

    const frameB = createFakeFrame({ evaluateResult: discoveryResult({ elements: [rawElement('e1', { accessibleName: 'Farklı Buton' })] }) });
    const pageB = createFakePage({ frames: [frameB], mainFrame: frameB, url: 'https://example.com' });
    const { snapshot: snapB } = await analyzer.analyze(pageB as never, fakeOptions());

    expect(snapB.stateHash).not.toBe(snapA.stateHash);
  });
});
