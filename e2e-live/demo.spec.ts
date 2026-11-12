import { expect, test } from '@playwright/test';
import expected from '../tests/expected.json' with { type: 'json' };

/**
 * v0.2.0 demo as ONE continuous chat with the real model (PAID: 3 reserved requests):
 * overview -> biggest answer-rate drop -> drill action to call detail -> layout edit on one message -> follow-up.
 */
test('chat demo flow, live model, no manual workarounds', async ({ page }) => {
  const started = Date.now();
  const reports = page.locator('[data-report-id]');
  const ask = async (q: string) => { await page.getByTestId('question').fill(q); await page.getByTestId('ask').click(); await expect(page.getByTestId('loading')).toHaveCount(0, { timeout: 45_000 }); };

  await page.goto('/');
  await ask('Take a look at how each Campaign did last week');
  const r1 = reports.nth(0);
  await expect(r1.getByTestId('source-badge')).toHaveText('Live model response');
  await expect(r1.getByTestId('calls_card-value')).toHaveText(String(expected.totals.calls));

  await ask("Which Campaign's answer rate dropped the most?");
  const r2 = reports.nth(1);
  await expect(r2.getByTestId('agent-text')).toContainText('dropped the most');
  expect(await r2.locator('[data-scene-id="change_ranking"] tbody tr').evaluateAll((els) => els.map((e) => e.getAttribute('data-campaign')))).toEqual(expected.changeRankingOrder);

  await r2.getByTestId('drill-c2').click();
  const r3 = reports.nth(2);
  await expect(r3.getByTestId('agent-text')).toContainText(`${expected.c2Unanswered.total} unanswered calls`);
  await r3.getByTestId('outcome-filter').selectOption('busy');
  await r3.locator('[data-scene-id="call_list"] tbody tr').first().click();
  await expect(r3.getByTestId('detail-outcome')).toHaveText('busy');

  await r1.getByTestId('edit-layout').click();
  await page.getByTestId('up-answer_rate_card').click();
  await page.getByTestId('pin-answer_rate_card').check();
  await page.getByTestId('apply').click();
  await expect(page.getByTestId('edit-modal')).toHaveCount(0);
  await expect(r1.locator('[data-scene-id="answer_rate_card"]')).toHaveAttribute('data-pinned', 'true');
  await expect(r2.locator('[data-scene-id="answer_rate_card"]')).toHaveAttribute('data-pinned', 'false');

  await ask('add a daily call volume trend');
  await expect(reports).toHaveCount(4);
  await expect(reports.nth(3).locator('[data-scene-id="daily_call_volume"]')).toBeVisible();
  await expect(r1.getByTestId('calls_card-value')).toHaveText(String(expected.totals.calls)); // history intact
  const seconds = (Date.now() - started) / 1000;
  console.log(`demo flow took ${seconds.toFixed(1)}s (scripted; includes real model latency)`);
  expect(seconds).toBeLessThan(120);
});
