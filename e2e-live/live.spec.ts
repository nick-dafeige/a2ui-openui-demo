import { expect, test } from '@playwright/test';
import expected from '../tests/expected.json' with { type: 'json' };

const reports = (page: import('@playwright/test').Page) => page.locator('[data-report-id]');
const ask = async (page: import('@playwright/test').Page, q: string) => { await page.getByTestId('question').fill(q); await page.getByTestId('ask').click(); };

test('live model: overview answer carries text, cards, chart and table with a Live badge', async ({ page }) => {
  await page.goto('/');
  await ask(page, 'Take a look at how each Campaign did last week');
  const r = reports(page).first();
  await expect(r.getByTestId('source-badge')).toHaveText('Live model response', { timeout: 45_000 });
  await expect(r.getByTestId('range-label')).toHaveText('2026-11-02 to 2026-11-08');
  await expect(r.getByTestId('calls_card-value')).toHaveText(String(expected.totals.calls));
  await expect(r.locator('[data-scene-id="campaign_table"]')).toBeVisible();
});

test("live model: 'which dropped the most' appends a second answer; the first stays", async ({ page }) => {
  await page.goto('/');
  await ask(page, 'Take a look at how each Campaign did last week');
  await expect(reports(page)).toHaveCount(1, { timeout: 45_000 });
  await ask(page, "Which Campaign's answer rate dropped the most?");
  await expect(reports(page)).toHaveCount(2, { timeout: 45_000 });
  const r2 = reports(page).nth(1);
  await expect(r2.getByTestId('periods')).toContainText('2026-10-26 to 2026-11-01');
  expect(await r2.locator('[data-scene-id="change_ranking"] tbody tr').evaluateAll((els) => els.map((e) => e.getAttribute('data-campaign')))).toEqual(expected.changeRankingOrder);
  await expect(reports(page).first().getByTestId('calls_card-value')).toHaveText(String(expected.totals.calls));
});

test('live model: "expand this campaign" with nothing selected shows the campaign list; no report is added', async ({ page }) => {
  await page.goto('/');
  await ask(page, 'Expand this Campaign');
  await expect(page.getByTestId('messages')).toContainText('Which campaign do you mean?', { timeout: 45_000 });
  await expect(reports(page)).toHaveCount(0);
});

test('live model: unknown metric lists available metrics; no report is added', async ({ page }) => {
  await page.goto('/');
  await ask(page, 'What was the revenue per call last week?');
  await expect(page.getByTestId('messages')).toContainText('Available metrics:', { timeout: 45_000 });
  await expect(reports(page)).toHaveCount(0);
});
