import type { AgentDecision, RunReport } from '../../domain/types.js';

/**
 * Bu modül GERÇEK bir "kod üretici" DEĞİLDİR — sistemin kendisi hiçbir zaman senaryodan önceden
 * statik Playwright kodu üretip onu çalıştırmaz (bkz. proje mimarisi: canlı DOM analizi + adım
 * adım AI kararı). Bu fonksiyon, SADECE eski frontend'in "Generated Code" panelinde göstermek
 * istediği bir kod parçasını, ajanın YAPTIĞI (geçmişe dönük) adımlardan SENTEZLER.
 *
 * KULLANICI TERCİHİ (bilinçli tasarım kararı): panel SADECE kod satırları göstersin isteniyor —
 * adım açıklaması, hata uyarısı, dosya başı NOT bloğu gibi HİÇBİR yorum satırı YOK. Terminal
 * kararlar (finish_success/finish_failure/ask_clarification) gerçek bir Playwright çağrısına
 * karşılık gelmediği için (bkz. describeAction) satır ÜRETMEZ, sessizce atlanır.
 *
 * "Run" ile yeniden çalıştırıldığında bu statik kod DEĞİL, AI ajanı orijinal senaryoyu sayfanın
 * o anki güncel DOM'una göre yeniden çalıştırır — üretilen bu metin sadece geçmişe dönük bir
 * kayıttır, birebir yeniden çalıştırılabilir bir script olması garanti edilmez.
 */
export function synthesizeTestCode(report: RunReport): string {
  const lines: string[] = [];

  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push('');
  lines.push(`test(${JSON.stringify(truncate(report.scenario, 100))}, async ({ page }) => {`);
  lines.push(`  await page.goto(${JSON.stringify(report.url)});`);

  for (const step of report.steps) {
    const line = describeAction(step.decision);
    if (line) lines.push(`  ${line}`);
  }

  lines.push('});');

  return lines.join('\n');
}

function describeAction(d: AgentDecision): string | null {
  const ref = d.targetRef ? `page.locator('[data-ai-ref="${d.targetRef}"]')` : 'page';
  const value = d.value !== undefined ? JSON.stringify(d.value) : undefined;

  switch (d.action) {
    case 'click':
      return `await ${ref}.click();`;
    case 'dblclick':
      return `await ${ref}.dblclick();`;
    case 'fill':
      return `await ${ref}.fill(${value ?? "''"});`;
    case 'type':
      return `await ${ref}.pressSequentially(${value ?? "''"});`;
    case 'press_key':
      return d.targetRef ? `await ${ref}.press(${value ?? "''"});` : `await page.keyboard.press(${value ?? "''"});`;
    case 'select_option':
      return `await ${ref}.selectOption(${value ?? "''"});`;
    case 'check':
      return `await ${ref}.check();`;
    case 'uncheck':
      return `await ${ref}.uncheck();`;
    case 'hover':
      return `await ${ref}.hover();`;
    case 'scroll_into_view':
      return `await ${ref}.scrollIntoViewIfNeeded();`;
    case 'navigate':
      return `await page.goto(${value ?? "''"});`;
    case 'go_back':
      return `await page.goBack();`;
    case 'wait':
      return `await page.waitForTimeout(${Number(d.value) || 1000});`;
    case 'assert_visible':
      return `await expect(${ref}).toBeVisible();`;
    case 'assert_text':
      return `await expect(page.locator('body')).toContainText(${value ?? "''"});`;
    case 'assert_url':
      return `await expect(page).toHaveURL(new RegExp(${JSON.stringify(escapeRegExp(d.value ?? ''))}));`;
    // Terminal kararlar (AgentLoop tarafından ele alınır, ActionExecutor'a hiç gitmez) gerçek bir
    // Playwright çağrısına karşılık gelmez — kullanıcı tercihi gereği yorum satırı da EKLENMEZ,
    // satır tamamen atlanır (bkz. dosya başı NOT).
    case 'finish_success':
    case 'finish_failure':
    case 'ask_clarification':
      return null;
    default:
      return null;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
