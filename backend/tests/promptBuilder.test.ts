import { describe, expect, it } from 'vitest';
import { buildSystemMessage, buildUserMessage, type HistoryEntry } from '../src/core/llm/PromptBuilder.js';
import { SecretsVault } from '../src/core/secrets/SecretsVault.js';
import type { DiscoveredElement, PageSnapshot } from '../src/domain/types.js';

function makeElement(overrides: Partial<DiscoveredElement> = {}): DiscoveredElement {
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

function makeSnapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://example.com/login',
    title: 'Giriş Yap',
    elements: [makeElement()],
    totalDiscovered: 1,
    stateHash: 'hash-abc',
    alerts: [],
    ...overrides,
  };
}

describe('buildSystemMessage', () => {
  it('role "system" ve boş olmayan bir içerik döner', () => {
    const message = buildSystemMessage();

    expect(message.role).toBe('system');
    expect(message.content.length).toBeGreaterThan(0);
    expect(message.content).toContain('JSON');
  });
});

describe('buildUserMessage', () => {
  it('senaryoyu, başlangıç URL’ini ve adım bilgisini içerir (1-tabanlı adım / azami adım)', () => {
    const vault = new SecretsVault();
    const message = buildUserMessage({
      scenario: 'Ana sayfayı ziyaret et',
      startUrl: 'https://example.com',
      snapshot: makeSnapshot(),
      history: [],
      vault,
      stepIndex: 2,
      maxSteps: 10,
    });

    expect(message.role).toBe('user');
    expect(message.content).toContain('Ana sayfayı ziyaret et');
    expect(message.content).toContain('https://example.com');
    expect(message.content).toContain('3 / azami 10');
  });

  it('değişkenleri (variables) DEĞERLERİYLE birlikte, secret’ları ise SADECE ADLARIYLA gösterir — gerçek secret değeri asla içermez', () => {
    const vault = new SecretsVault({ aramaTerimi: 'laptop' }, { PASSWORD: 'ÇokGizliBirŞifre123!' });
    const message = buildUserMessage({
      scenario: 'Giriş yap',
      startUrl: 'https://example.com',
      snapshot: makeSnapshot(),
      history: [],
      vault,
      stepIndex: 0,
      maxSteps: 10,
    });

    // Değişken değeri açıkça geçmeli (hassas değil).
    expect(message.content).toContain('laptop');
    // Secret'ın SADECE adı geçmeli.
    expect(message.content).toContain('PASSWORD');
    // KRİTİK GÜVENLİK DOĞRULAMASI: gerçek secret değeri prompt'ta HİÇBİR ŞEKİLDE bulunmamalı.
    expect(message.content).not.toContain('ÇokGizliBirŞifre123!');
  });

  it('hiç değişken/secret yoksa "(yok)" yazar', () => {
    const vault = new SecretsVault();
    const message = buildUserMessage({
      scenario: 'Ana sayfayı ziyaret et',
      startUrl: 'https://example.com',
      snapshot: makeSnapshot(),
      history: [],
      vault,
      stepIndex: 0,
      maxSteps: 5,
    });

    expect(message.content).toContain('KULLANILABİLİR DEĞİŞKENLER');
    expect(message.content).toContain('(yok)');
  });

  it('snapshot.alerts boşsa uyarı bölümünü hiç eklemez; doluysa her uyarıyı listeler', () => {
    const vault = new SecretsVault();
    const withoutAlerts = buildUserMessage({
      scenario: 's',
      startUrl: 'https://example.com',
      snapshot: makeSnapshot({ alerts: [] }),
      history: [],
      vault,
      stepIndex: 0,
      maxSteps: 5,
    });
    expect(withoutAlerts.content).not.toContain('SAYFADAKİ GÖRÜNÜR UYARI');

    const withAlerts = buildUserMessage({
      scenario: 's',
      startUrl: 'https://example.com',
      snapshot: makeSnapshot({ alerts: ['Geçersiz e-posta adresi'] }),
      history: [],
      vault,
      stepIndex: 0,
      maxSteps: 5,
    });
    expect(withAlerts.content).toContain('SAYFADAKİ GÖRÜNÜR UYARI');
    expect(withAlerts.content).toContain('Geçersiz e-posta adresi');
  });

  it('geçmiş boşsa "(henüz aksiyon yok)" yazar; doluysa OK/HATA sonucuyla birlikte listeler', () => {
    const vault = new SecretsVault();
    const empty = buildUserMessage({
      scenario: 's',
      startUrl: 'https://example.com',
      snapshot: makeSnapshot(),
      history: [],
      vault,
      stepIndex: 0,
      maxSteps: 5,
    });
    expect(empty.content).toContain('(henüz aksiyon yok)');

    const history: HistoryEntry[] = [
      {
        stepIndex: 0,
        decision: { action: 'click', targetRef: 'e1', reasoning: 'tıklandı' },
        resultOk: true,
        resultMessage: 'Tıklandı: e1',
      },
      {
        stepIndex: 1,
        decision: { action: 'fill', targetRef: 'e2', reasoning: 'dolduruldu' },
        maskedValue: '***',
        resultOk: false,
        resultMessage: 'Element bulunamadı',
      },
    ];
    const withHistory = buildUserMessage({
      scenario: 's',
      startUrl: 'https://example.com',
      snapshot: makeSnapshot(),
      history,
      vault,
      stepIndex: 2,
      maxSteps: 5,
    });
    expect(withHistory.content).toContain('#0 click -> e1');
    expect(withHistory.content).toContain('sonuç: OK');
    expect(withHistory.content).toContain('#1 fill -> e2');
    expect(withHistory.content).toContain('sonuç: HATA');
    // Maskelenmiş değer prompt'ta görünmeli, "***"; gerçek değer değil.
    expect(withHistory.content).toContain('"***"');
  });

  it('elementleri ref/tag/role/name/value/frame/attribute/[DISABLED] bilgileriyle biçimlendirir', () => {
    const vault = new SecretsVault();
    const message = buildUserMessage({
      scenario: 's',
      startUrl: 'https://example.com',
      snapshot: makeSnapshot({
        elements: [
          makeElement({ ref: 'e5', tag: 'button', accessibleName: 'Gönder', enabled: false, frame: 'checkout-iframe' }),
        ],
      }),
      history: [],
      vault,
      stepIndex: 0,
      maxSteps: 5,
    });

    expect(message.content).toContain('e5');
    expect(message.content).toContain('<button>');
    expect(message.content).toContain('name="Gönder"');
    expect(message.content).toContain('frame=checkout-iframe');
    expect(message.content).toContain('[DISABLED]');
  });

  it('bir <select>’in "options" listesi varsa bunu JSON dizisi olarak elemente ekler (hepsiburada.com "sırala" regresyon koruması)', () => {
    const vault = new SecretsVault();
    const message = buildUserMessage({
      scenario: 's',
      startUrl: 'https://example.com',
      snapshot: makeSnapshot({
        elements: [
          makeElement({
            ref: 'e9',
            tag: 'select',
            role: 'combobox',
            accessibleName: null,
            currentValue: 'Önerilen sıralama',
            options: ['Önerilen sıralama', 'En düşük fiyat', 'En yüksek fiyat'],
          }),
        ],
      }),
      history: [],
      vault,
      stepIndex: 0,
      maxSteps: 5,
    });

    expect(message.content).toContain('e9');
    expect(message.content).toContain('value="Önerilen sıralama"');
    expect(message.content).toContain(
      'options=' + JSON.stringify(['Önerilen sıralama', 'En düşük fiyat', 'En yüksek fiyat']),
    );
  });

  it('"options" alanı yoksa (ör. select olmayan elementler) formatta hiç "options=" segmenti görünmez', () => {
    const vault = new SecretsVault();
    const message = buildUserMessage({
      scenario: 's',
      startUrl: 'https://example.com',
      snapshot: makeSnapshot({ elements: [makeElement({ ref: 'e2', tag: 'button', options: undefined })] }),
      history: [],
      vault,
      stepIndex: 0,
      maxSteps: 5,
    });

    expect(message.content).not.toContain('options=');
  });

  it('hiç element yoksa "(hiç etkileşilebilir element bulunamadı)" yazar', () => {
    const vault = new SecretsVault();
    const message = buildUserMessage({
      scenario: 's',
      startUrl: 'https://example.com',
      snapshot: makeSnapshot({ elements: [] }),
      history: [],
      vault,
      stepIndex: 0,
      maxSteps: 5,
    });

    expect(message.content).toContain('(hiç etkileşilebilir element bulunamadı)');
  });
});
