import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseEnv } from './helpers/fakeEnv.js';

const ENV_MODULE = '../src/config/env.js';

vi.doMock(ENV_MODULE, () => ({ env: baseEnv() }));
const { BrowserManager } = await import('../src/core/browser/BrowserManager.js');

/**
 * NOT: launch() gerçekten çağrıldığında Playwright GERÇEK bir tarayıcı süreci başlatır — bu,
 * hızlı/izole bir birim test paketi için uygun değildir (yavaş, tarayıcı ikili dosyalarının
 * kurulu olmasını gerektirir, CI'da flaky olabilir). Bu yüzden burada SADECE launch() ÇAĞRILMADAN
 * önceki/sonraki güvenli durum yönetimini ve adoptNewestPageIfOpened()'in saf mantığını (gerçek
 * bir context/page yerine sahte nesnelerle enjekte edilerek) test ediyoruz. Gerçek launch()
 * akışının uçtan uca doğrulanması, bu projenin manuel/entegrasyon test kapsamındadır.
 */

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('BrowserManager — launch() öncesi güvenli durum', () => {
  it('getPage(): launch() hiç çağrılmadan çağrılırsa açıklayıcı bir hata fırlatır', () => {
    const manager = new BrowserManager();

    expect(() => manager.getPage()).toThrow(/başlatılmadı/);
  });

  it('adoptNewestPageIfOpened(): context hiç yoksa false döner (no-op)', async () => {
    const manager = new BrowserManager();

    await expect(manager.adoptNewestPageIfOpened()).resolves.toBe(false);
  });

  it('close(): hiçbir şey başlatılmamışken bile hata fırlatmadan (best-effort) tamamlanır', async () => {
    const manager = new BrowserManager();

    await expect(manager.close()).resolves.toEqual({});
  });
});

describe('BrowserManager — adoptNewestPageIfOpened() sekme değiştirme mantığı (enjekte edilmiş sahte context/page ile)', () => {
  it('sadece TEK sekme açıksa (yeni sekme yok) false döner ve mevcut page değişmez', async () => {
    const manager = new BrowserManager();
    const onlyPage = { video: vi.fn().mockReturnValue(null), on: vi.fn(), waitForLoadState: vi.fn(), close: vi.fn() };
    const fakeContext = { pages: vi.fn().mockReturnValue([onlyPage]) };
    // TS "private" alanlar derleme-zamanı kısıtlamasıdır; test amaçlı doğrudan enjekte ediyoruz.
    (manager as unknown as { context: unknown; page: unknown }).context = fakeContext;
    (manager as unknown as { context: unknown; page: unknown }).page = onlyPage;

    const switched = await manager.adoptNewestPageIfOpened();

    expect(switched).toBe(false);
  });

  it('YENİ bir sekme açılmışsa (ve BAŞTAN itibaren gerçek bir URL\'deyse): aktif page’i en yeni sekmeye geçirir ve diğer (durgun) sekmeleri kapatır', async () => {
    const manager = new BrowserManager();
    const oldPage = { video: vi.fn().mockReturnValue(null), on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const newestPage = {
      video: vi.fn().mockReturnValue(null),
      on: vi.fn(),
      // Boş (about:blank/data:) DEĞİL — bu yüzden v2.3'teki grace-period bekleme mantığına hiç
      // girmeden, eskisi gibi ANINDA adopte edilmeli.
      url: vi.fn().mockReturnValue('https://example.com/product'),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const staleTab = { close: vi.fn().mockResolvedValue(undefined) };
    const fakeContext = { pages: vi.fn().mockReturnValue([oldPage, staleTab, newestPage]) };
    (manager as unknown as { context: unknown; page: unknown }).context = fakeContext;
    (manager as unknown as { context: unknown; page: unknown }).page = oldPage;

    const switched = await manager.adoptNewestPageIfOpened();

    expect(switched).toBe(true);
    expect(manager.getPage()).toBe(newestPage);
    // "Yetim" sekmeler (en yeni olmayan HERKES) kapatılmalı — sadece bir öncekiler değil.
    expect(staleTab.close).toHaveBeenCalled();
    expect(oldPage.close).toHaveBeenCalled();
    expect(newestPage.close).not.toHaveBeenCalled();
  });
});

describe('adoptNewestPageIfOpened() — boş (about:blank/data:) yeni sekmeyi yok sayma (v2.3)', () => {
  it('yeni sekme grace period boyunca SÜREKLİ boş kalırsa (pop-under): yok sayılıp KAPATILIR, aktif sayfa DEĞİŞMEZ', async () => {
    vi.useFakeTimers();
    const manager = new BrowserManager();
    const oldPage = { video: vi.fn().mockReturnValue(null), on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const newestPage = {
      video: vi.fn().mockReturnValue(null),
      on: vi.fn(),
      url: vi.fn().mockReturnValue('about:blank'), // hiç navigasyon yapmıyor — ölü pop-under
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const fakeContext = { pages: vi.fn().mockReturnValue([oldPage, newestPage]) };
    (manager as unknown as { context: unknown; page: unknown }).context = fakeContext;
    (manager as unknown as { context: unknown; page: unknown }).page = oldPage;

    const resultPromise = manager.adoptNewestPageIfOpened();
    await vi.advanceTimersByTimeAsync(2000); // grace period'dan (1200ms) fazla
    const switched = await resultPromise;

    expect(switched).toBe(false);
    // Aktif sayfa hâlâ eski (asıl kullanışlı) sayfa — DEĞİŞMEDİ.
    expect(manager.getPage()).toBe(oldPage);
    // Ölü sekmenin kendisi kapatıldı...
    expect(newestPage.close).toHaveBeenCalled();
    // ...ama asıl (kullanışlı) sekmeye DOKUNULMADI.
    expect(oldPage.close).not.toHaveBeenCalled();
  });

  it('yeni sekme İLK BAŞTA boşsa ama grace period içinde GERÇEK bir URL\'e navigasyon yaparsa: normal şekilde adopte edilir', async () => {
    vi.useFakeTimers();
    const manager = new BrowserManager();
    const oldPage = { video: vi.fn().mockReturnValue(null), on: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
    const urlMock = vi
      .fn()
      .mockReturnValueOnce('data:,')
      .mockReturnValueOnce('data:,')
      .mockReturnValue('https://example.com/product'); // birkaç poll turu sonra gerçek URL'e geçiyor
    const newestPage = {
      video: vi.fn().mockReturnValue(null),
      on: vi.fn(),
      url: urlMock,
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const fakeContext = { pages: vi.fn().mockReturnValue([oldPage, newestPage]) };
    (manager as unknown as { context: unknown; page: unknown }).context = fakeContext;
    (manager as unknown as { context: unknown; page: unknown }).page = oldPage;

    const resultPromise = manager.adoptNewestPageIfOpened();
    await vi.advanceTimersByTimeAsync(2000);
    const switched = await resultPromise;

    expect(switched).toBe(true);
    expect(manager.getPage()).toBe(newestPage);
    expect(oldPage.close).toHaveBeenCalled(); // artık "stale" — kapatılmalı
    expect(newestPage.close).not.toHaveBeenCalled();
  });
});
