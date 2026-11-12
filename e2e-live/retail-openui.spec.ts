import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * PAID: the v0.5.0 vertical slice with the REAL model in the real browser: explain -> home what-if -> adopt -> store appointment ->
 * submit. The setup before the first model turn uses Rules-only (no calls). Roughly 11-14 reserved requests (typed turn = plan + Lang,
 * pressed control = one Lang call, a repair is one more). Checks outcomes (state, components, bindings), not just that the API answered.
 * Writes screenshots, the raw programs and the server traces to evidence/$RUN_DIR/browser/.
 */
const OUT = `evidence/${process.env.RUN_DIR ?? 'v0.5.0-live-browser'}/browser`;
const last = (page: Page, id: string) => page.getByTestId(id).last();
const idle = (page: Page) => expect(page.getByTestId('rt-loading')).toHaveCount(0, { timeout: 120_000 });
const say = async (page: Page, text: string) => { await page.getByTestId('rt-question').fill(text); await page.getByTestId('rt-ask').click(); await idle(page); };
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });

test('v0.5.0 vertical slice with the REAL model: model-written Lang, validated, rendered, acted on, submitted', async ({ page, request }) => {
  test.setTimeout(420_000);
  mkdirSync(OUT, { recursive: true });
  const sent: { id: string; ui: unknown; event: boolean }[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/retail/interpret')) { const b = JSON.parse(r.postData() ?? '{}'); sent.push({ id: r.headers()['x-request-id'], ui: b.ui, event: !!b.event }); } });
  await page.goto('/'); await page.getByTestId('mode-retail').click();
  await page.getByTestId('rt-interpreter').selectOption('rules');             // setup without model calls
  await page.getByTestId('rt-sample').click();
  await last(page, 'rt-orders').getByTestId('rt-order-RT-20260620-1001').locator('input').click();
  await last(page, 'rt-symptoms').getByTestId('rt-symptom-one_side_silent').check();
  await last(page, 'rt-symptoms').getByTestId('rt-symptoms-done').click();
  await last(page, 'rt-deadline-date-input').fill('2026-11-16'); await last(page, 'rt-deadline-date-confirm').click();
  await page.getByTestId('rt-question').fill('Exchange, ship it to my company'); await page.getByTestId('rt-ask').click();
  await expect(last(page, 'rt-address').getByTestId('rt-addr-summary')).toContainText('Company · Example Tower');
  await page.getByTestId('rt-interpreter').selectOption('model');
  await expect(page.getByTestId('rt-ui-mode')).toHaveValue('openui');
  const changedBefore = await page.getByText(/^Changed:/).count();

  // 1. explanation: a direct answer inside a model-written interface; nothing changes
  await say(page, "My flight leaves on the 16th and I'm nervous about being without headphones. Why would you steer me towards a swap rather than a fix?");
  await expect(last(page, 'rt-lang')).toBeVisible();
  const explain = await last(page, 'rt-lang').innerText();
  expect(explain.length).toBeGreaterThan(60); expect(explain).not.toMatch(/ask away/i);
  await expect(page.getByText(/^Changed:/)).toHaveCount(changedBefore);
  await shot(page, '1-explain');

  // 2. hypothetical: a what-if table from application bindings, address untouched
  await say(page, 'Hypothetically, if the parcel went to my flat instead of the office, would that change anything? Leave my details alone for now.');
  const cmp = last(page, 'ou-compare');
  await expect(cmp).toBeVisible();
  await expect(cmp.getByTestId('ou-whatif-badge')).toHaveText('What-if only · nothing was changed');
  await expect(cmp.getByTestId('ou-cmp-row-exchange')).toContainText('Nov 15 · ¥0.00');
  await expect(page.getByText(/^Changed:/)).toHaveCount(changedBefore);
  await expect(page.getByTestId('rt-address-value').last()).toContainText('Company · Example Tower');
  await shot(page, '2-what-if');

  // 3. adoption through the model-written button: only the delivery address changes
  await last(page, 'rt-lang').getByTestId('ou-quick').first().click();
  await idle(page);
  await expect(page.getByText(/^Changed:/)).toHaveCount(changedBefore + 1);
  const changed = page.getByText(/^Changed:/).last();
  await expect(changed).toContainText('Delivery address: Company · Example Tower → Home');
  await expect(changed).not.toContainText('Plan:');
  await expect(page.getByTestId('rt-lang').nth(1)).toHaveAttribute('data-live', 'false');       // the earlier what-if is frozen
  await shot(page, '3-adopted');

  // 4. follow the model-written questions to a store appointment (adaptive: act on whatever input the interface offers, at most 8 steps)
  for (let i = 0; i < 8; i++) {
    const lang = last(page, 'rt-lang');
    if (await page.getByTestId('rt-confirm').count()) break;
    if (await lang.getByTestId('ou-opt-method.store').count()) await lang.getByTestId('ou-opt-method.store').click();
    else if (await lang.getByTestId('ou-opt-loc.company').count()) await lang.getByTestId('ou-opt-loc.company').click();
    else if (await lang.getByTestId('ou-opt-sp.sp-2').count()) { await expect(lang.getByTestId('ou-opt-sp.sp-3')).toHaveCount(0); await shot(page, '4-service-points'); await lang.getByTestId('ou-opt-sp.sp-2').click(); }
    else if (await lang.getByTestId('ou-form').count()) {
      const form = lang.getByTestId('ou-form');
      await form.getByTestId('ou-date-input-pickupDate').fill('2026-11-13');
      await expect(form.getByTestId('ou-slot-09:00-12:00')).toHaveCount(0);                  // store opens at 10:00
      await shot(page, '5-appointment-form');
      await form.getByTestId('ou-slot-14:00-18:00').click(); await form.getByTestId('ou-form-submit').click();
    } else break;
    await idle(page);
  }
  const cf = last(page, 'rt-confirm');
  await expect(cf).toContainText('New District Store');
  await expect(cf).toContainText('14:00-18:00');
  await shot(page, '6-confirm');
  await expect(page.getByTestId('rt-receipt')).toHaveCount(0);
  await cf.getByTestId('rt-submit').click();
  const rc = last(page, 'rt-receipt');
  await expect(rc).toContainText('you drop off the old unit'); await expect(rc).not.toContainText('picked up');
  await shot(page, '7-receipt');

  // trace: every model request of this flow is a real call, with ids the server recorded; Lang turns carry the validation verdict
  const server = (await (await request.get('/api/retail/trace')).json()).traces as { requestId: string; modelCalled: boolean; calls: { stage: string; modelCalled: boolean; httpStatus: number | null; budgetReservation: number | null }[]; turn: { lang?: { ok: boolean; attempts: number; repaired: boolean } } | null }[];
  const mine = sent.map((s) => server.find((t) => t.requestId === s.id)!);
  expect(mine.every((t) => t && t.modelCalled && t.calls.every((c) => c.modelCalled && c.httpStatus === 200 && c.budgetReservation))).toBe(true);
  expect(sent.every((s) => s.ui === 'openui')).toBe(true);
  expect(sent.filter((s) => s.event).length).toBeGreaterThanOrEqual(3);                        // pressed controls went through the event path
  const requests = mine.reduce((a, t) => a + t.calls.length, 0);
  const langs = mine.map((t) => t.turn?.lang).filter(Boolean);
  expect(langs.every((l) => l!.ok)).toBe(true);
  writeFileSync(`${OUT}/trace.json`, JSON.stringify({ requests, turns: mine.length, lang: langs, serverTraces: mine }, null, 1));
  console.log(`model requests in this flow: ${requests} over ${mine.length} turns; repairs: ${langs.filter((l) => l!.repaired).length}`);
});
