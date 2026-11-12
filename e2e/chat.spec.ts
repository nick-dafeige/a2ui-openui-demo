import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import expected from '../tests/expected.json' with { type: 'json' };

const mockPlan = (page: Page, body: unknown, delayMs = 0) =>
  page.route('**/api/plan', async (r) => { if (delayMs) await new Promise((x) => setTimeout(x, delayMs)); await r.fulfill({ json: body as object }); });
const reports = (page: Page) => page.locator('[data-report-id]');
const ask = async (page: Page, q: string) => { await page.getByTestId('question').fill(q); await page.getByTestId('ask').click(); };
const ids = (r: ReturnType<Page['locator']>) => r.locator('[data-scene-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-scene-id')!));
const OVERVIEW = { kind: 'plan', request: { intent: 'campaign_overview', range: { start: '2026-11-02', end: '2026-11-08' } }, source: 'live' };
const CHANGE = { kind: 'plan', request: { intent: 'change_analysis' }, source: 'live' };

test.beforeEach(async ({ page }) => { await page.goto('/'); });

test('5.1 chat-centric page: wide stream, composer at the bottom, no side report area', async ({ page }) => {
  await expect(page.getByTestId('messages')).toBeVisible();
  const vp = page.viewportSize()!;
  const box = (await page.getByTestId('question').boundingBox())!;
  expect(box.y + box.height).toBeGreaterThan(vp.height - 120); // composer pinned to the bottom
  await page.getByTestId('prepared-overview').click();
  const rep = (await reports(page).first().boundingBox())!;
  expect(rep.width).toBeGreaterThan(vp.width * 0.6);            // wide, not a narrow side column
  await expect(page.locator('aside, main.report')).toHaveCount(0);
});

test('5.2/5.3/5.4/5.5 three-turn conversation: every answer stays in the stream with its own scope', async ({ page }) => {
  // turn 1: overview
  await mockPlan(page, OVERVIEW);
  await ask(page, 'How did each campaign do last week?');
  await expect(reports(page)).toHaveCount(1);
  const r1 = reports(page).nth(0);
  await expect(r1.getByTestId('agent-text')).toContainText(`${expected.totals.calls} calls, 48.3% answered`);
  await expect(r1.getByTestId('calls_card-value')).toHaveText(String(expected.totals.calls));
  await expect(r1.locator('[data-scene-id="daily_trend"]')).toBeVisible();
  await expect(r1.locator('[data-scene-id="campaign_table"]')).toBeVisible();
  await expect(r1.getByTestId('source-badge')).toHaveText('Live model response');
  await expect(r1.getByTestId('range-label')).toHaveText('2026-11-02 to 2026-11-08');

  // turn 2: biggest answer-rate drop
  await page.unroute('**/api/plan'); await mockPlan(page, CHANGE);
  await ask(page, 'Which campaign had the biggest answer-rate drop?');
  await expect(reports(page)).toHaveCount(2);
  const r2 = reports(page).nth(1);
  await expect(r2.getByTestId('agent-text')).toContainText('Payment Reminder dropped the most');
  await expect(r2.getByTestId('periods')).toContainText('2026-10-26 to 2026-11-01');
  await expect(r2.locator('[data-scene-id="change_ranking"]')).toBeVisible();
  await expect(r2.locator('[data-scene-id="daily_trend"]')).toBeVisible();
  await expect(r2.getByTestId('basis')).toContainText('2026-10-26 to 2026-11-01');
  expect(await r2.locator('[data-scene-id="change_ranking"] tbody tr').evaluateAll((els) => els.map((e) => e.getAttribute('data-campaign')))).toEqual(expected.changeRankingOrder);

  await expect(r2.getByTestId('agent-text')).toContainText('Tiny Sample Test fell more (-50.0 pp)');
  await expect(r2.locator('tr[data-campaign="c6"]')).toContainText('low sample');
  // turn 3: the primary drill action points at the conclusion campaign; logged in the stream
  await expect(r2.getByTestId('drill-action')).toContainText('Payment Reminder');
  await r2.getByTestId('drill-action').click();
  await expect(reports(page)).toHaveCount(3);
  await expect(page.getByTestId('action-msg').last()).toContainText('View unanswered calls · Payment Reminder · 2026-11-02 to 2026-11-08');
  const r3 = reports(page).nth(2);
  await expect(r3.getByTestId('agent-text')).toContainText(`${expected.c2Unanswered.total} unanswered calls`);
  await expect(r3.getByTestId('source-badge')).toHaveText('Direct action · no model call');
  await expect(r3.getByTestId('range-label')).toHaveText('2026-11-02 to 2026-11-08');
  await expect(r3.locator('[data-scene-id="call_list"] tbody tr')).toHaveCount(10);

  // history is intact and still shows its own figures and scope
  await expect(r1.getByTestId('calls_card-value')).toHaveText(String(expected.totals.calls));
  await expect(r1.locator('[data-scene-id="call_list"]')).toHaveCount(0);
  await expect(r2.getByTestId('change-c2')).toHaveText('-20.0 pp');
  await expect(reports(page)).toHaveCount(3);
});

test('top 3 by answer rate returns exactly three ranked campaigns, over all campaigns', async ({ page }) => {
  await mockPlan(page, { kind: 'plan', request: { intent: 'campaign_overview', campaignIds: ['c1'] }, source: 'live' }); await ask(page, 'only spring');
  await page.unroute('**/api/plan');
  await mockPlan(page, { kind: 'plan', request: { intent: 'campaign_overview', metrics: ['answer_rate'], sortBy: 'answer_rate', order: 'desc', limit: 3 }, source: 'live' });
  await ask(page, 'show me the top 3 campaign of answer rate');
  const r = reports(page).nth(1);
  await expect(r.getByTestId('agent-text')).toHaveText('Top 3 campaigns by answer rate, 2026-11-02 to 2026-11-08: 1. Spring Renewal 65.0%; 2. Winback Offer 50.0%; 3. Survey Pilot 50.0%.');
  expect(await r.locator('[data-scene-id="campaign_table"] tbody tr').evaluateAll((els) => els.map((e) => e.getAttribute('data-campaign')))).toEqual(['c1', 'c3', 'c4']);
  await expect(r.getByTestId('campaigns-label')).toHaveText('All campaigns');
  await expect(r.locator('[data-scene-id]')).toHaveCount(1);
  expect(await r.locator('[data-scene-id="campaign_table"] thead th').allTextContents()).toEqual(['#', 'Campaign', 'Answer rate']); // no extra columns
  expect(await r.locator('[data-scene-id="campaign_table"] tbody tr').first().locator('td').allTextContents()).toEqual(['1', 'Spring Renewal', '65.0%']);
});

test('free composition: exactly the named components, and call list with one campaign', async ({ page }) => {
  await mockPlan(page, { kind: 'plan', request: { intent: 'campaign_overview', components: ['change_ranking', 'daily_call_volume'], only: true }, source: 'live' });
  await ask(page, 'only the change ranking and a daily call volume chart');
  const r = reports(page).first();
  await expect(r.locator('[data-scene-id="change_ranking"]')).toBeVisible();
  expect((await ids(r)).sort()).toEqual(['change_ranking', 'daily_call_volume']);
  await expect(r.getByTestId('agent-text')).toContainText('Payment Reminder dropped the most');
  await page.unroute('**/api/plan');
  await mockPlan(page, { kind: 'plan', request: { intent: 'campaign_overview', components: ['answer_rate_card', 'call_list'], campaignIds: ['c2'], only: true }, source: 'live' });
  await ask(page, 'answer rate card and unanswered calls for Payment Reminder');
  const r2 = reports(page).nth(1);
  await expect(r2.locator('[data-scene-id="call_list"] tbody tr')).toHaveCount(10);
  expect((await ids(r2)).sort()).toEqual(['answer_rate_card', 'call_list']);
  await expect(r2.getByTestId('drill-summary')).toContainText(`${expected.c2Unanswered.total} unanswered calls`);
  await expect(reports(page).first().locator('[data-scene-id]')).toHaveCount(2); // history intact
});

test('only conversion rate shows a single card', async ({ page }) => {
  await mockPlan(page, { kind: 'plan', request: { intent: 'campaign_overview', metrics: ['conversion_rate'], only: true }, source: 'live' });
  await ask(page, 'just the conversion rate');
  const r = reports(page).first();
  await expect(r.getByTestId('conversion_card-value')).toHaveText('23.9%');
  expect(await ids(r)).toEqual(['conversion_card']);
  await expect(r.getByTestId('agent-text')).toContainText('conversion rate 23.9%');
});

test('5.4 a later query with another range does not overwrite earlier reports', async ({ page }) => {
  await mockPlan(page, OVERVIEW); await ask(page, 'last week');
  await page.unroute('**/api/plan');
  await mockPlan(page, { kind: 'plan', request: { intent: 'campaign_overview', range: { start: '2026-10-26', end: '2026-11-01' }, campaignIds: ['c1'] }, source: 'live' });
  await ask(page, 'week before, Spring Renewal only');
  await expect(reports(page)).toHaveCount(2);
  await expect(reports(page).nth(0).getByTestId('range-label')).toHaveText('2026-11-02 to 2026-11-08');
  await expect(reports(page).nth(0).getByTestId('campaigns-label')).toHaveText('All campaigns');
  await expect(reports(page).nth(0).getByTestId('calls_card-value')).toHaveText(String(expected.totals.calls));
  await expect(reports(page).nth(1).getByTestId('range-label')).toHaveText('2026-10-26 to 2026-11-01');
  await expect(reports(page).nth(1).getByTestId('campaigns-label')).toHaveText('Spring Renewal');
  await expect(reports(page).nth(1).getByTestId('calls_card-value')).toHaveText('200');
});

test('5.6 drill-down: filter, sort, paging, per-report filters, detail — all inside the message, no new messages', async ({ page }) => {
  await page.getByTestId('prepared-drilldown_c2').click();
  const r = reports(page).first();
  const before = await page.locator('[data-testid="agent-msg"]').count();
  await expect(r.getByTestId('drill-summary')).toContainText(`Payment Reminder · ${expected.c2Unanswered.total} unanswered calls · 2026-11-02 to 2026-11-08`);
  await expect(r.getByTestId('page-label')).toHaveText('Page 1 of 18');

  await r.getByTestId('outcome-filter').selectOption('failed');
  await expect(r.getByTestId('page-label')).toHaveText('Page 1 of 3');
  const seen: string[] = [];
  for (let p = 1; p <= 3; p++) {
    for (const x of await r.locator('[data-scene-id="call_list"] tbody tr').evaluateAll((els) => els.map((e) => [e.getAttribute('data-call'), e.getAttribute('data-outcome'), e.getAttribute('data-time')]))) {
      expect(x[1]).toBe('failed'); expect(x[2]! >= '2026-11-02' && x[2]! < '2026-11-09').toBe(true); seen.push(x[0]!);
    }
    if (p < 3) await r.getByTestId('page-next').click();
  }
  expect(seen).toHaveLength(expected.c2Unanswered.failed); expect(new Set(seen).size).toBe(seen.length);
  await expect(r.getByTestId('page-next')).toBeDisabled();

  await r.getByTestId('outcome-filter').selectOption('');
  await r.getByTestId('sort-time').click();
  const times = await r.locator('[data-scene-id="call_list"] tbody tr').evaluateAll((els) => els.map((e) => e.getAttribute('data-time')!));
  expect(times).toEqual([...times].sort());

  const first = r.locator('[data-scene-id="call_list"] tbody tr').first();
  const [id, outcome] = [await first.getAttribute('data-call'), await first.getAttribute('data-outcome')];
  await first.click();
  await expect(r.getByTestId('detail-id')).toHaveText(id!);
  await expect(r.getByTestId('detail-outcome')).toHaveText(outcome!);
  await r.getByTestId('close-detail').click();
  await expect(r.getByTestId('call-detail')).toHaveCount(0);

  // per-report date filter narrows only this report's list; reset restores the asked scope
  await r.getByTestId('filters').locator('summary').click();
  await r.getByTestId('range-end').fill('2026-11-03');
  await expect(r.getByTestId('modified')).toBeVisible();
  const narrow = await r.locator('[data-scene-id="call_list"] tbody tr').evaluateAll((els) => els.map((e) => e.getAttribute('data-time')!));
  expect(narrow.length).toBeGreaterThan(0); expect(narrow.every((t) => t >= '2026-11-02' && t < '2026-11-04')).toBe(true);
  await r.getByTestId('clear-filters').click();
  await expect(r.getByTestId('range-label')).toHaveText('2026-11-02 to 2026-11-08');
  await expect(r.getByTestId('modified')).toHaveCount(0);
  expect(await page.locator('[data-testid="agent-msg"]').count()).toBe(before); // nothing was appended
});

test('5.6 filtering one report does not touch another', async ({ page }) => {
  await page.getByTestId('prepared-overview').click(); await page.getByTestId('prepared-change').click();
  const [a, b] = [reports(page).nth(0), reports(page).nth(1)];
  await a.getByTestId('filters').locator('summary').click();
  await a.getByTestId('filter-c1').uncheck();
  await expect(a.getByTestId('calls_card-value')).toHaveText(String(expected.totals.calls - expected.campaigns.c1.calls));
  await expect(b.getByTestId('campaigns-label')).toHaveText('All campaigns');
  await expect(b.getByTestId('change-c1')).toHaveText('+15.0 pp');
});

test('5.8 model failure / unknown metric / ambiguous campaign become messages; earlier reports stay', async ({ page }) => {
  await page.getByTestId('prepared-overview').click();
  await ask(page, 'How did campaigns do last week?'); // dev server is in stub-fail mode: no paid call
  await expect(page.getByTestId('error-banner')).toBeVisible();
  await expect(page.getByTestId('messages')).toContainText('Earlier reports are unchanged');
  await expect(reports(page).first().getByTestId('calls_card-value')).toHaveText(String(expected.totals.calls));
  await expect(reports(page).first().getByTestId('source-badge')).toHaveText('Prepared fallback analysis');
  await page.getByRole('button', { name: /Prepared: Answer-rate change/ }).click();
  await expect(page.getByTestId('error-banner')).toHaveCount(0);
  await expect(reports(page)).toHaveCount(2);

  await mockPlan(page, { kind: 'unknown_metric', available: ['calls', 'answer_rate'] });
  await ask(page, 'revenue');
  await expect(page.getByTestId('messages')).toContainText('That metric is not available. Available metrics: calls, answer_rate');
  await page.unroute('**/api/plan'); await mockPlan(page, { kind: 'need_campaign' });
  await ask(page, 'expand this campaign');
  await expect(page.getByTestId('messages').getByRole('button', { name: 'Payment Reminder', exact: true })).toBeVisible();
  await expect(reports(page)).toHaveCount(2);
});

test('loading indicator shows while the query runs', async ({ page }) => {
  await mockPlan(page, CHANGE, 800);
  await ask(page, 'which dropped');
  await expect(page.getByTestId('loading')).toBeVisible();
  await expect(page.getByTestId('messages')).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByTestId('loading')).toHaveCount(0);
  await expect(reports(page)).toHaveCount(1);
});

test.describe('layout editing from a report message (5.7)', () => {
  const RED = 'rgb(220, 38, 38)';
  async function edit(page: Page, r: ReturnType<Page['locator']>, save: boolean) {
    await r.getByTestId('edit-layout').click();
    await expect(page.getByTestId('edit-modal')).toBeVisible();
    await page.getByTestId('up-answer_rate_card').click();
    await page.getByTestId('width-answer_rate_card').selectOption('full');
    await page.getByTestId('accent-answer_rate_card').selectOption('red');
    await page.getByTestId('pin-answer_rate_card').check();
    await page.getByTestId(save ? 'apply-save' : 'apply').click();
    await expect(page.getByTestId('edit-modal')).toHaveCount(0);
  }

  test('Apply changes only that report; later reports use the default; Cancel changes nothing', async ({ page }) => {
    await page.getByTestId('prepared-overview').click(); await page.getByTestId('prepared-overview').click();
    const [a, b] = [reports(page).nth(0), reports(page).nth(1)];
    const before = await ids(a);
    await a.getByTestId('edit-layout').click(); await page.getByTestId('up-answer_rate_card').click(); await page.getByTestId('cancel').click();
    expect(await ids(a)).toEqual(before);

    await edit(page, a, false);
    expect((await ids(a))[0]).toBe('answer_rate_card');
    const card = a.locator('[data-scene-id="answer_rate_card"]');
    await expect(card).toHaveAttribute('data-pinned', 'true'); await expect(card).toHaveCSS('border-top-color', RED);
    await expect(a.getByTestId('answer_rate_card-value')).toHaveText('48.3%'); // meaning unchanged
    expect(await ids(b)).toEqual(before);                                      // the other report is untouched
    await page.getByTestId('prepared-overview').click();                        // not saved as preference => new report is default
    expect(await ids(reports(page).nth(2))).toEqual(before);
  });

  test('explicit save-as-preference applies to future reports, survives refresh, and a pin never forces a component into later replies', async ({ page }) => {
    await page.getByTestId('prepared-overview').click();
    await edit(page, reports(page).first(), true);
    await expect(page.getByTestId('action-msg').last()).toContainText('saved as preference');
    await page.getByTestId('prepared-change').click(); // change analysis has answer_rate_card
    expect((await ids(reports(page).nth(1)))[0]).toBe('answer_rate_card');
    await expect(reports(page).nth(1).locator('[data-scene-id="answer_rate_card"]')).toHaveCSS('border-top-color', RED);
    await page.getByTestId('prepared-drilldown_c2').click(); // pinned card is NOT repeated here
    expect(await ids(reports(page).nth(2))).toEqual(['call_list']);
    await page.reload(); await page.getByTestId('prepared-overview').click();
    expect((await ids(reports(page).first()))[0]).toBe('answer_rate_card');
  });

  test('"Save layout as preference" button saves without opening the editor', async ({ page }) => {
    await page.getByTestId('prepared-overview').click();
    await reports(page).first().getByTestId('save-pref').click();
    await expect(page.getByTestId('action-msg').last()).toContainText('saved as preference');
    await expect(page.getByTestId('edit-modal')).toHaveCount(0);
  });

  test('unmappable layout is reported and the report keeps its layout', async ({ page }) => {
    await page.getByTestId('prepared-overview').click();
    const a = reports(page).first(); const before = await ids(a);
    await page.route('**/api/layout/apply', (r) => r.abort());
    await a.getByTestId('edit-layout').click();
    await page.getByTestId('pin-calls_card').check();
    await page.getByTestId('apply').click();
    await expect(page.getByTestId('edit-message')).toContainText('could not be mapped');
    await page.getByTestId('cancel').click();
    expect(await ids(a)).toEqual(before);
    await expect(a.locator('[data-scene-id="calls_card"]')).toHaveAttribute('data-pinned', 'false');
  });

  test('OpenPencil design file: off-palette colour rejected; supported edits import into the draft', async ({ page }) => {
    const FIG = join(process.cwd(), '.scene-data/design.fig');
    const pencil = (code: string) => execFileSync(join(process.cwd(), 'node_modules/.bin/openpencil'), ['eval', FIG, '-w', '-q', '-c', code]);
    await page.getByTestId('prepared-overview').click();
    await reports(page).first().getByTestId('edit-layout').click();
    await page.getByTestId('export-fig').click();
    await expect(page.getByTestId('edit-message')).toContainText('Design file written');
    pencil('const n=figma.currentPage.children[0].children.find(n=>n.name==="scene-daily_trend");n.fills=[{type:"SOLID",color:{r:0.5,g:0.5,b:0.5}}];');
    await page.getByTestId('import-fig').click();
    await expect(page.getByTestId('edit-message')).toContainText('Unsupported colour on "daily_trend"');
    await page.getByTestId('export-fig').click();
    await expect(page.getByTestId('edit-message')).toContainText('Design file written');
    pencil(`const r=figma.currentPage.children[0];r.insertChild(0,r.children.find(n=>n.name==="scene-campaign_table"));r.children.find(n=>n.name==="scene-campaign_table").locked=true;`);
    await page.getByTestId('import-fig').click();
    await expect(page.getByTestId('edit-message')).toContainText('Imported edits');
    await page.getByTestId('apply').click();
    await expect(page.getByTestId('edit-modal')).toHaveCount(0);
    expect((await ids(reports(page).first()))[0]).toBe('campaign_table');
  });
});
