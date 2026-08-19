import { describe, expect, it, vi } from 'vitest';
import { baseDefaultRunOptions, baseEnv } from './helpers/fakeEnv.js';
import type { LlmProvider } from '../src/core/llm/LlmProvider.js';
import type { DiscoveredElement } from '../src/domain/types.js';
import type { LegacyGeneratedTestMeta, LegacyRunRecord } from '../src/domain/legacyTypes.js';

vi.mock('../src/config/env.js', () => ({ env: baseEnv(), defaultRunOptions: baseDefaultRunOptions() }));

const launchMock = vi.fn();
const closeMock = vi.fn().mockResolvedValue({});
vi.mock('../src/core/browser/BrowserManager.js', () => ({
  BrowserManager: vi.fn().mockImplementation(() => ({ launch: launchMock, close: closeMock })),
}));

vi.mock('../src/core/browser/ConsentBannerHandler.js', () => ({
  dismissConsentBanners: vi.fn().mockResolvedValue(undefined),
}));

const analyzeMock = vi.fn();
vi.mock('../src/core/dom/DomAnalyzer.js', () => ({
  DomAnalyzer: vi.fn().mockImplementation(() => ({ analyze: analyzeMock })),
}));

const generatedListMock = vi.fn().mockResolvedValue([]);
vi.mock('../src/core/legacy/GeneratedTestStore.js', () => ({
  GeneratedTestStore: vi.fn().mockImplementation(() => ({ list: generatedListMock })),
}));

const runsListMock = vi.fn().mockResolvedValue([]);
vi.mock('../src/core/legacy/TestRunStore.js', () => ({
  TestRunStore: vi.fn().mockImplementation(() => ({ list: runsListMock })),
}));

const { ScenarioSuggester } = await import('../src/core/scenario/ScenarioSuggester.js');
const { ValidationError } = await import('../src/domain/errors.js');

function fakeElement(overrides: Partial<DiscoveredElement> = {}): DiscoveredElement {
  return {
    ref: 'e1',
    tag: 'input',
    role: 'textbox',
    accessibleName: 'E-posta',
    text: null,
    attributes: { type: 'email' },
    visible: true,
    enabled: true,
    frame: 'main',
    ...overrides,
  };
}

function setupHappyDefaults(elements: DiscoveredElement[] = [fakeElement()]): void {
  // scanPage() DomAnalyzer'ı çağırmadan ÖNCE page.goto()'yu DOĞRUDAN (mock'lanmamış gerçek kodla)
  // çağırıyor — bu yüzden sahte page nesnesi en azından .goto()'ya sahip olmalı, aksi halde
  // "page.goto is not a function" hatası scanPage'in catch bloğunda yutulup yanıltıcı bir
  // "Sayfa ziyaret edilemedi" ValidationError'ına dönüşür (gerçek hatayı gizler).
  const fakePage = { goto: vi.fn().mockResolvedValue(undefined) };
  launchMock.mockReset().mockResolvedValue(fakePage);
  closeMock.mockReset().mockResolvedValue({});
  analyzeMock.mockReset().mockResolvedValue({ snapshot: { url: 'https://example.com', title: 'Örnek Sayfa', elements, totalDiscovered: elements.length, stateHash: 'h', alerts: [] } });
  generatedListMock.mockReset().mockResolvedValue([]);
  runsListMock.mockReset().mockResolvedValue([]);
}

function fakeLlm(completeImpl: (...args: unknown[]) => Promise<string>): { provider: LlmProvider; completeMock: ReturnType<typeof vi.fn> } {
  const completeMock = vi.fn(completeImpl);
  return { provider: { name: 'fake', complete: completeMock }, completeMock };
}

describe('ScenarioSuggester.suggest', () => {
  it('mutlu yol: sayfayı tarar, LLM’den geçerli önerileri alır ve döner', async () => {
    setupHappyDefaults();
    const raw = JSON.stringify([
      { title: 'Giriş Yap', scenario: 'E-posta ve şifre ile giriş yap.' },
      { title: 'Geçersiz E-posta ile Doğrulama', scenario: 'E-posta alanına "abc" yaz ve hata mesajını doğrula.' },
    ]);
    const { provider, completeMock } = fakeLlm(async () => raw);
    const suggester = new ScenarioSuggester(provider);

    const suggestions = await suggester.suggest('https://example.com');

    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]?.title).toBe('Giriş Yap');
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(completeMock).toHaveBeenCalledTimes(1);

    const userMessage = completeMock.mock.calls[0]?.[0]?.[1];
    expect(userMessage.content).toContain('https://example.com');
    expect(userMessage.content).toContain('Örnek Sayfa');
  });

  it('LLM çağrısına AÇIKÇA yüksek bir maxTokens iletir (varsayılan 1024, 3-6 senaryo içeren bir JSON dizisi için yetersiz kalıp yanıtın ortasında kesilmesine yol açıyordu — bkz. OpenRouterProvider/GeminiProvider testleri)', async () => {
    setupHappyDefaults();
    const { provider, completeMock } = fakeLlm(async () => JSON.stringify([{ title: 'X', scenario: 'Y' }]));
    const suggester = new ScenarioSuggester(provider);

    await suggester.suggest('https://example.com');

    const callOptions = completeMock.mock.calls[0]?.[1];
    expect(callOptions?.maxTokens).toBeGreaterThan(1024);
  });

  it('sayfada hiç etkileşilebilir element yoksa ValidationError fırlatır ve LLM’i hiç çağırmaz', async () => {
    setupHappyDefaults([]);
    const { provider, completeMock } = fakeLlm(async () => '[]');
    const suggester = new ScenarioSuggester(provider);

    await expect(suggester.suggest('https://example.com')).rejects.toBeInstanceOf(ValidationError);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('sayfa ziyaret edilemezse (browserManager.launch başarısız olursa) anlaşılır bir ValidationError fırlatır', async () => {
    setupHappyDefaults();
    launchMock.mockReset().mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED'));
    const { provider } = fakeLlm(async () => '[]');
    const suggester = new ScenarioSuggester(provider);

    await expect(suggester.suggest('https://example.com')).rejects.toThrow(/Sayfa ziyaret edilemedi/);
  });

  it('LLM çağrısı ağ hatasıyla başarısız olursa anlaşılır bir ValidationError fırlatır', async () => {
    setupHappyDefaults();
    const { provider } = fakeLlm(async () => {
      throw new Error('network timeout');
    });
    const suggester = new ScenarioSuggester(provider);

    await expect(suggester.suggest('https://example.com')).rejects.toThrow(/AI'dan senaryo önerisi alınamadı/);
  });

  it('LLM geçersiz JSON döndürürse (3 denemenin hepsinde) ValidationError fırlatır', async () => {
    setupHappyDefaults();
    const { provider, completeMock } = fakeLlm(async () => 'bu JSON değil');
    const suggester = new ScenarioSuggester(provider);

    await expect(suggester.suggest('https://example.com')).rejects.toThrow(/geçerli bir öneri listesi/);
    // MAX_SUGGEST_RETRIES = 2 -> toplam 3 deneme (0, 1, 2).
    expect(completeMock).toHaveBeenCalledTimes(3);
  });

  it('ilk yanıt geçersiz JSON olsa bile, düzeltme isteğiyle tekrar denenir ve ikinci denemede geçerli öneriler alınırsa başarıyla döner', async () => {
    setupHappyDefaults();
    let callCount = 0;
    const { provider, completeMock } = fakeLlm(async () => {
      callCount += 1;
      if (callCount === 1) return 'bu JSON değil, üzgünüm bir hata oldu';
      return JSON.stringify([{ title: 'Yeni Senaryo', scenario: 'Bir akış dene.' }]);
    });
    const suggester = new ScenarioSuggester(provider);

    const suggestions = await suggester.suggest('https://example.com');

    expect(suggestions).toHaveLength(1);
    expect(completeMock).toHaveBeenCalledTimes(2);

    // İkinci istekte, önceki geçersiz yanıtla ilgili bir düzeltme mesajı EKLENMİŞ olmalı.
    const secondCallMessages = completeMock.mock.calls[1]?.[0];
    expect(secondCallMessages).toHaveLength(3);
    expect(secondCallMessages[2].content).toContain('Önceki yanıtın geçersizdi');
  });

  it('model JSON dizisini kod bloğu olmadan düz metinle sarmalarsa (ör. "İşte öneriler:\\n[...]"), yine de köşeli parantez aralığı çıkarılıp ayrıştırılır (tek denemede, retry gerekmez)', async () => {
    setupHappyDefaults();
    const raw = 'İşte önerilerim:\n[{"title": "Arama Yap", "scenario": "Arama kutusuna yaz ve ara."}]\nUmarım yardımcı olur!';
    const { provider, completeMock } = fakeLlm(async () => raw);
    const suggester = new ScenarioSuggester(provider);

    const suggestions = await suggester.suggest('https://example.com');

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.title).toBe('Arama Yap');
    expect(completeMock).toHaveBeenCalledTimes(1);
  });

  it('önerileri en fazla 6 ile sınırlar ve şekli uymayan (title/scenario eksik) öğeleri filtreler', async () => {
    setupHappyDefaults();
    const items = [
      ...Array.from({ length: 8 }, (_, i) => ({ title: `Senaryo ${i}`, scenario: `Açıklama ${i}` })),
      { title: 'Eksik senaryo alanı' }, // geçersiz şekil, filtrelenmeli
    ];
    const { provider } = fakeLlm(async () => JSON.stringify(items));
    const suggester = new ScenarioSuggester(provider);

    const suggestions = await suggester.suggest('https://example.com');

    expect(suggestions).toHaveLength(6);
  });

  it('aynı sitede (hostname) daha önce çalıştırılmış senaryoları geçmiş olarak LLM’e iletir (BAŞARILI/BAŞARISIZ etiketleriyle)', async () => {
    setupHappyDefaults();
    const generatedTests: LegacyGeneratedTestMeta[] = [
      { fileName: 'a.spec.ts', createdAt: '2026-01-01T00:00:00.000Z', url: 'https://example.com/old-page', scenario: 'Eski senaryo: sepete ürün ekle', variables: {}, browser: 'chromium', headed: true, screenshot: false, video: false, trace: false },
    ];
    const runs: LegacyRunRecord[] = [
      { id: 'run-1', testFile: 'a.spec.ts', status: 'failed', browser: 'chromium', duration: 3, createdAt: '2026-01-01T00:00:00.000Z', exitCode: 1 },
    ];
    generatedListMock.mockResolvedValue(generatedTests);
    runsListMock.mockResolvedValue(runs);

    const { provider, completeMock } = fakeLlm(async () => JSON.stringify([{ title: 'Yeni Senaryo', scenario: 'Farklı bir akış dene.' }]));
    const suggester = new ScenarioSuggester(provider);

    await suggester.suggest('https://example.com');

    const userMessage = completeMock.mock.calls[0]?.[0]?.[1];
    expect(userMessage.content).toContain('GEÇMİŞTE BU SİTEDE ÇALIŞTIRILAN SENARYOLAR');
    expect(userMessage.content).toContain('[BAŞARISIZ]');
    expect(userMessage.content).toContain('Eski senaryo: sepete ürün ekle');
  });

  it('farklı bir hostname’deki geçmiş testleri geçmişe DAHİL ETMEZ', async () => {
    setupHappyDefaults();
    generatedListMock.mockResolvedValue([
      { fileName: 'a.spec.ts', createdAt: '2026-01-01T00:00:00.000Z', url: 'https://baska-site.com', scenario: 'Alakasız senaryo', variables: {}, browser: 'chromium', headed: true, screenshot: false, video: false, trace: false },
    ]);
    const { provider, completeMock } = fakeLlm(async () => JSON.stringify([{ title: 'X', scenario: 'Y' }]));
    const suggester = new ScenarioSuggester(provider);

    await suggester.suggest('https://example.com');

    const userMessage = completeMock.mock.calls[0]?.[0]?.[1];
    expect(userMessage.content).not.toContain('Alakasız senaryo');
  });

  it('"Get More Suggestions" akışı: existingScenarios verilirse, bunları tekrarlamama talimatıyla birlikte LLM’e iletir', async () => {
    setupHappyDefaults();
    const { provider, completeMock } = fakeLlm(async () => JSON.stringify([{ title: 'Yeni Senaryo', scenario: 'Farklı bir akış dene.' }]));
    const suggester = new ScenarioSuggester(provider);

    await suggester.suggest('https://example.com', true, ['Arama kutusuna X yaz ve ara.', 'Giriş yap.']);

    const userMessage = completeMock.mock.calls[0]?.[0]?.[1];
    expect(userMessage.content).toContain('BU OTURUMDA ZATEN ÖNERİLMİŞ SENARYOLAR');
    expect(userMessage.content).toContain('Arama kutusuna X yaz ve ara.');
    expect(userMessage.content).toContain('Giriş yap.');
  });

  it('existingScenarios boşsa (varsayılan) prompt’a "zaten önerilmiş" bloğu HİÇ eklenmez', async () => {
    setupHappyDefaults();
    const { provider, completeMock } = fakeLlm(async () => JSON.stringify([{ title: 'X', scenario: 'Y' }]));
    const suggester = new ScenarioSuggester(provider);

    await suggester.suggest('https://example.com');

    const userMessage = completeMock.mock.calls[0]?.[0]?.[1];
    expect(userMessage.content).not.toContain('BU OTURUMDA ZATEN ÖNERİLMİŞ SENARYOLAR');
  });

  it('focus verilirse (ör. "login sayfasıyla ilgili senaryo üret"), prompt\'a "KULLANICININ ÖZEL İSTEĞİ" bloğu olarak eklenir', async () => {
    setupHappyDefaults();
    const { provider, completeMock } = fakeLlm(async () => JSON.stringify([{ title: 'X', scenario: 'Y' }]));
    const suggester = new ScenarioSuggester(provider);

    await suggester.suggest('https://example.com', true, [], 'login sayfasıyla ilgili senaryo üret');

    const userMessage = completeMock.mock.calls[0]?.[0]?.[1];
    expect(userMessage.content).toContain('KULLANICININ ÖZEL İSTEĞİ');
    expect(userMessage.content).toContain('login sayfasıyla ilgili senaryo üret');
  });

  it('focus boşsa (varsayılan) prompt\'a "KULLANICININ ÖZEL İSTEĞİ" bloğu HİÇ eklenmez', async () => {
    setupHappyDefaults();
    const { provider, completeMock } = fakeLlm(async () => JSON.stringify([{ title: 'X', scenario: 'Y' }]));
    const suggester = new ScenarioSuggester(provider);

    await suggester.suggest('https://example.com');

    const userMessage = completeMock.mock.calls[0]?.[0]?.[1];
    expect(userMessage.content).not.toContain('KULLANICININ ÖZEL İSTEĞİ');
  });
});
