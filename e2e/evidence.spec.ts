import { test } from '@playwright/test';
/** Screenshots of the three-turn flow for evidence/v0.2.0 (mocked plans, no model call). */
test('capture three-turn flow', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const plan = (body: object) => page.route('**/api/plan', (r) => r.fulfill({ json: body }));
  await page.goto('/');
  await plan({ kind: 'plan', request: { intent: 'campaign_overview', range: { start: '2026-11-02', end: '2026-11-08' } }, source: 'live' });
  await page.getByTestId('question').fill('How did each campaign do last week?'); await page.getByTestId('ask').click();
  await page.locator('[data-report-id]').nth(0).waitFor();
  await page.screenshot({ path: 'evidence/v0.2.0/01-overview.png' });
  await page.unroute('**/api/plan'); await plan({ kind: 'plan', request: { intent: 'change_analysis' }, source: 'live' });
  await page.getByTestId('question').fill('Which campaign had the biggest answer-rate drop?'); await page.getByTestId('ask').click();
  await page.locator('[data-report-id]').nth(1).waitFor();
  await page.screenshot({ path: 'evidence/v0.2.0/02-change.png' });
  await page.getByTestId('drill-action').click();
  await page.locator('[data-report-id]').nth(2).waitFor();
  await page.locator('[data-report-id]').nth(2).locator('tbody tr').first().click();
  await page.screenshot({ path: 'evidence/v0.2.0/03-drill-detail.png' });
  await page.locator('[data-report-id]').nth(0).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'evidence/v0.2.0/04-history-preserved.png', fullPage: false });
});
