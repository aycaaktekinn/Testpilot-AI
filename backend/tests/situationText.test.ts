import { describe, it, expect } from 'vitest';
import { buildSituationText, safeHostname } from '../src/core/vectorcache/situationText.js';
import type { DiscoveredElement, PageSnapshot } from '../src/domain/types.js';

function fakeSnapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://example.com/login',
    title: 'Login Page',
    elements: [],
    totalDiscovered: 0,
    stateHash: 'hash1',
    alerts: [],
    ...overrides,
  };
}

function fakeElement(overrides: Partial<DiscoveredElement> = {}): DiscoveredElement {
  return {
    ref: 'e1',
    tag: 'input',
    role: 'textbox',
    accessibleName: 'Kullanici Adi',
    text: null,
    attributes: {},
    visible: true,
    enabled: true,
    frame: 'main',
    ...overrides,
  };
}

describe('buildSituationText', () => {
  it('senaryo, adim, domain, baslik ve elementleri icerir', () => {
    const snapshot = fakeSnapshot({ elements: [fakeElement()] });
    const text = buildSituationText({ scenario: 'Login ol', snapshot, stepIndex: 0 });

    expect(text).toContain('SENARYO: Login ol');
    expect(text).toContain('ADIM: 1');
    expect(text).toContain('DOMAIN: example.com');
    expect(text).toContain('BAŞLIK: Login Page');
    expect(text).toContain('<input>');
    expect(text).toContain('role=textbox');
    expect(text).toContain('name="Kullanici Adi"');
  });

  it('hic element yoksa placeholder yazar', () => {
    const text = buildSituationText({ scenario: 'x', snapshot: fakeSnapshot(), stepIndex: 0 });
    expect(text).toContain('(hiç etkileşilebilir element yok)');
  });

  it('ana ozgu detaylar (attributes/currentValue/options) DAHIL EDILMEZ', () => {
    const snapshot = fakeSnapshot({
      elements: [
        fakeElement({
          accessibleName: 'Arama',
          attributes: { placeholder: 'ara...' },
          currentValue: 'gizli-arama-terimi',
          options: ['secenek-a', 'secenek-b'],
        }),
      ],
    });
    const text = buildSituationText({ scenario: 'x', snapshot, stepIndex: 0 });

    expect(text).not.toContain('gizli-arama-terimi');
    expect(text).not.toContain('placeholder');
    expect(text).not.toContain('secenek-a');
  });

  it('adim indexini 1 tabanli gosterir (stepIndex 0 -> ADIM: 1)', () => {
    const text = buildSituationText({ scenario: 'x', snapshot: fakeSnapshot(), stepIndex: 4 });
    expect(text).toContain('ADIM: 5');
  });
});

describe('safeHostname', () => {
  it('gecerli bir URLden hostname cikarir', () => {
    expect(safeHostname('https://example.com/path?x=1')).toBe('example.com');
  });

  it('gecersiz bir URL icin ham degeri dondurur', () => {
    expect(safeHostname('not-a-url')).toBe('not-a-url');
  });
});
