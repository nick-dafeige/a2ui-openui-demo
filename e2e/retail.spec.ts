import { expect, test, type Page } from '@playwright/test';

// Offline: the dev server runs in stub-fail mode, so the retail interpreter falls back to the rules parser (labelled).
const O1 = 'RT-20260620-1001', O2 = 'RT-20250418-0733';
const SAMPLE = 'My headphones are broken and I need them for a business trip next week. Please help.';
const last = (page: Page, id: string) => page.getByTestId(id).last();
const say = async (page: Page, text: string) => { await page.getByTestId('rt-question').fill(text); await page.getByTestId('rt-ask').click(); };
const quick = (page: Page, name: string) => page.getByRole('button', { name, exact: true }).last();
const agentText = (page: Page) => page.getByTestId('rt-agent-text');

/** Offline tests choose "Rules only" explicitly (header selector); the default is the model, which these tests never call. */
async function openRetail(page: Page, scenario?: string, interpreter: 'rules' | 'model' = 'rules') {
  await page.goto('/');
  await page.getByTestId('mode-retail').click();
  await expect(page.getByTestId('retail-app')).toBeVisible();
  await page.getByTestId('rt-interpreter').selectOption(interpreter);
  if (scenario) await page.getByTestId('rt-scenario').selectOption(scenario);
}
async function pickDate(page: Page, id: string, iso: string) {
  await last(page, `${id}-input`).fill(iso);
  await last(page, `${id}-confirm`).click();
}
/** natural-language path to the plan comparison */
async function toPlans(page: Page, o: { deadline?: string; who?: string } = {}) {
  await page.getByTestId('rt-sample').click();
  await expect(last(page, 'rt-orders')).toBeVisible();
  await say(page, o.who ?? 'The first one, the left side has no sound');
  await expect(last(page, 'rt-deadline')).toBeVisible();
  await pickDate(page, 'rt-deadline-date', o.deadline ?? '2026-11-16');
  await expect(last(page, 'rt-plans')).toBeVisible();
}
/** ...to the final summary with courier pickup */
async function toConfirm(page: Page) {
  await toPlans(page);
  await say(page, 'Exchange please');
  await expect(agentText(page).last()).toContainText('How would you like to send the old item back');
  await say(page, 'I want a courier to pick it up');
  await expect(last(page, 'rt-pickup')).toBeVisible();
  await last(page, 'rt-pickup-date').fill('2026-11-12');
  await last(page, 'rt-slot-09:00-12:00').click();
  await expect(last(page, 'rt-confirm')).toBeVisible();
}

test('R1 mode switch: Reporting is the default, Retail opens beside it, and neither loses its conversation', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('pane-reporting')).toBeVisible();
  await expect(page.getByTestId('demo-badge')).toBeVisible();
  await expect(page.getByTestId('retail-app')).toHaveCount(0);        // not mounted until first visit
  await page.getByTestId('prepared-overview').click();
  await expect(page.locator('[data-report-id]')).toHaveCount(1);
  await page.getByTestId('mode-retail').click();
  await expect(page.getByTestId('rt-demo-badge')).toContainText('Demo environment');
  await expect(page.getByTestId('pane-reporting')).toBeHidden();
  await page.getByTestId('rt-interpreter').selectOption('rules');
  await page.getByTestId('rt-sample').click();
  await expect(last(page, 'rt-orders')).toBeVisible();
  await page.getByTestId('mode-reporting').click();
  await expect(page.locator('[data-report-id]')).toHaveCount(1);       // reporting state kept
  await page.getByTestId('mode-retail').click();
  await expect(last(page, 'rt-orders')).toBeVisible();                 // retail state kept
  expect(page.url()).toContain('#/retail');
});

test('R2 mostly natural language: one question at a time, drop-off with service points, summary only at the end', async ({ page }) => {
  await openRetail(page);
  await page.getByTestId('rt-sample').click();
  await expect(page.getByTestId('rt-via').first()).toHaveText('Understood by rules (rules-only mode, no model call)');   // labelled: no model was used
  // turn 1: ONE small question (which order); no big form anywhere
  await expect(last(page, 'rt-orders')).toBeVisible();
  await expect(agentText(page).last()).toContainText('I found 2 headphone orders');
  await expect(page.locator('input[type=date]')).toHaveCount(0);
  await expect(page.locator('textarea')).toHaveCount(0);
  await expect(page.getByTestId('rt-symptoms')).toHaveCount(0);
  // turn 2: order + symptom come from the sentence, so only the date is asked
  await say(page, 'The first one, the left side has no sound');
  await expect(page.getByTestId('rt-orders-value')).toContainText('Aurora Pro');
  await expect(page.getByTestId('rt-orders-value')).toContainText('in warranty');
  await expect(page.getByTestId('rt-symptoms')).toHaveCount(0);                                         // never asked again
  await expect(agentText(page).last()).toContainText('exact day');                                      // "next week" is not a date
  await expect(page.getByTestId('rt-deadline')).toHaveCount(1);
  await expect(page.getByTestId('rt-plans')).toHaveCount(0);
  // typing a bad date is explained in the picker
  await last(page, 'rt-deadline-date-input').fill('2026-11-09');
  await expect(last(page, 'rt-deadline-date-error')).toContainText('must be after today');
  await expect(last(page, 'rt-deadline-date-confirm')).toBeDisabled();
  await pickDate(page, 'rt-deadline-date', '2026-11-16');
  // turn 3: compact plan comparison
  const plans = last(page, 'rt-plans');
  await expect(plans.getByTestId('rt-plan-exchange')).toHaveAttribute('data-timing', 'on_time');
  await expect(plans.getByTestId('rt-plan-repair')).toHaveAttribute('data-timing', 'late');
  await expect(plans.getByTestId('rt-plan-refund')).toHaveAttribute('data-timing', 'no_device');
  await expect(plans.getByTestId('rt-eta-exchange')).toContainText('Nov 15');
  await expect(plans.getByTestId('rt-fees-refund')).toContainText('¥719.20');
  await expect(plans.getByTestId('rt-plan-exchange').getByTestId('rt-recommended')).toBeVisible();
  await expect(plans.getByTestId('rt-plan-refund').getByTestId('rt-recommended')).toHaveCount(0);
  await expect(plans.getByTestId('rt-rec-text')).toContainText('before your Nov 16 deadline');
  await expect(page.getByTestId('rt-confirm')).toHaveCount(0);
  // turn 4: plan + company address in one sentence
  await say(page, 'Exchange, ship it to my company');
  await expect(page.getByTestId('rt-plans-value')).toContainText('Exchange · estimated delivery Nov 16');   // the answered comparison reads as the chosen plan, with the new numbers
  const addr = last(page, 'rt-address');
  await expect(addr.getByTestId('rt-address-map-pin-company-1')).toHaveAttribute('data-selected', 'true');
  await expect(addr.getByTestId('rt-recalc-exchange')).toContainText('Nov 16');
  await expect(addr.getByTestId('rt-recalc-exchange')).toContainText('Total ¥10.00');
  await expect(addr.getByTestId('rt-addr-form')).toHaveCount(0);                                        // a form only when an address is missing
  await expect(agentText(page).last()).toContainText('How would you like to send the old item back');
  // turn 5: the drop-off wish is understood and answered with ONE question
  await say(page, 'I would like to drop-off, give me the address');
  await expect(agentText(page).last()).toContainText('near your company or near your home');
  await expect(agentText(page).last()).not.toContainText('did not quite catch');
  await expect(page.getByTestId('rt-servicepoints')).toHaveCount(0);
  await say(page, 'Near my company');
  // turn 6: service points on a map + list (only those that handle exchange)
  const sps = last(page, 'rt-servicepoints');
  await expect(sps.getByTestId('rt-sp-map')).toBeVisible();
  await expect(sps.getByTestId('rt-sp-sp-1')).toContainText('Open 09:00-20:00');
  await expect(sps.getByTestId('rt-sp-sp-2')).toContainText('Appointment required');
  await expect(sps.getByTestId('rt-sp-sp-3')).toHaveCount(0);
  await sps.getByTestId('rt-sp-sp-1').locator('input').click();
  // turn 7: only the date is missing; the summary does not exist yet
  await expect(page.getByTestId('rt-servicepoints-value')).toContainText('Central Service Center');
  await expect(page.getByTestId('rt-confirm')).toHaveCount(0);
  await pickDate(page, 'rt-dropdate-date', '2026-11-13');
  // turn 8: the full summary appears, once
  const cf = last(page, 'rt-confirm');
  await expect(cf.getByTestId('rt-c-plan')).toHaveText('Exchange');
  await expect(cf.getByTestId('rt-c-fee')).toContainText('¥10.00');
  await expect(cf.getByTestId('rt-c-pickup')).toContainText('You drop it off · 2026-11-13');
  await expect(cf.getByTestId('rt-c-pickup')).toContainText('Central Service Center');
  await expect(cf.getByTestId('rt-c-delivery')).toContainText('Innovation Rd');
  await expect(cf.getByTestId('rt-c-deadline')).toContainText('expected to be met');
  await expect(page.getByTestId('rt-receipt')).toHaveCount(0);                                          // nothing created before the click
  await page.screenshot({ path: 'evidence/v0.3.0/screens/2-summary.png' });
  const feeText = (await cf.getByTestId('rt-c-fee').innerText()).replace(/\s+/g, '');
  const pickupText = (await cf.getByTestId('rt-c-pickup').innerText()).replace(/\s+/g, '');
  await cf.getByTestId('rt-submit').dblclick();                                                          // double click
  await expect(page.getByTestId('rt-receipt')).toHaveCount(1);
  const rc = page.getByTestId('rt-receipt');
  await expect(rc.getByTestId('rt-r-id')).toHaveText(/AS-20261110-\d{4}/);
  expect((await rc.getByTestId('rt-r-fee').innerText()).replace(/\s+/g, '')).toBe(feeText);              // receipt == what was confirmed
  expect((await rc.getByTestId('rt-r-pickup').innerText()).replace(/\s+/g, '')).toBe(pickupText);
  await expect(rc.getByTestId('rt-r-delivery')).toContainText('Innovation Rd');
  await expect(cf.getByTestId('rt-confirm-stale')).toHaveText('Submitted');
  await expect(cf.getByTestId('rt-submit')).toBeDisabled();
  await rc.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'evidence/v0.3.0/screens/3-receipt.png' });
  await rc.getByRole('button', { name: 'View progress' }).click();
  await expect(page.getByTestId('rt-progress')).toContainText('Demo environment');
  // a new requirement after submission goes to the change flow
  const id = await rc.getByTestId('rt-r-id').innerText();
  await say(page, 'Ship it to my home instead');
  await expect(page.getByTestId('rt-change')).toBeVisible();
  await expect(rc.getByTestId('rt-r-id')).toHaveText(id);
});

test('R3 the same journey with components only (choices, chips, date pickers, quick replies)', async ({ page }) => {
  await openRetail(page);
  let interpretCalls = 0;
  page.on('request', (r) => { if (r.url().includes('/api/retail/interpret')) interpretCalls++; });
  await page.getByTestId('rt-sample').click();
  const o = last(page, 'rt-orders');
  await o.getByTestId(`rt-order-${O1}`).locator('input').click();                                       // single-choice
  const s = last(page, 'rt-symptoms');                                                                  // multi-choice (asked because nothing was said)
  await s.getByTestId('rt-symptom-one_side_silent').check();
  await s.getByTestId('rt-symptom-charging').check();
  await s.getByTestId('rt-symptoms-done').click();
  await expect(page.getByTestId('rt-symptoms-value')).toContainText('One side silent, Charging problem');
  await pickDate(page, 'rt-deadline-date', '2026-11-16');                                               // date picker
  await last(page, 'rt-plans').getByTestId('rt-plan-radio-exchange').click();                          // single-choice plan
  await quick(page, 'Courier pickup').click();                                                          // quick reply
  const pk = last(page, 'rt-pickup');
  await expect(pk.getByTestId('rt-pickup-from')).toContainText('1 Example Rd');
  await expect(pk.getByTestId('rt-slot-09:00-12:00')).toHaveCount(0);                                   // slots only after a date
  await pk.getByTestId('rt-pickup-date').fill('2026-11-13');
  await expect(pk.getByTestId('rt-slot-18:00-20:00')).toBeDisabled();                                   // full: (13+2)%5==0
  await pk.getByTestId('rt-slot-14:00-18:00').click();
  await expect(last(page, 'rt-confirm').getByTestId('rt-c-pickup')).toContainText('2026-11-13 14:00-18:00');
  await last(page, 'rt-confirm').getByTestId('rt-submit').click();
  await expect(page.getByTestId('rt-receipt')).toHaveCount(1);
  await expect(page.getByTestId('rt-orders-change')).toHaveCount(0);                                    // locked after submission
  expect(interpretCalls).toBe(0);                                                                       // rules-only mode never sends a request; clicks are direct actions anyway
});

test('R4 an answered question can be changed from its summary; the rest is kept', async ({ page }) => {
  await openRetail(page);
  await toPlans(page);
  await page.getByTestId('rt-deadline-change').click();
  await pickDate(page, 'rt-deadline-date', '2026-11-13');
  await expect(last(page, 'rt-plans').getByTestId('rt-rec-text')).toContainText('No plan can get');   // recomputed for the new date
  await expect(page.getByTestId('rt-orders-value')).toContainText('Aurora Pro');                         // item kept
});

test('R5 asking for the drop-off address mid-conversation, with no company address: straight to the list, no extra question', async ({ page }) => {
  await openRetail(page, 'no_company');
  await toPlans(page);
  await say(page, 'Repair is fine. I want to drop it off myself, where can I go?');
  await expect(last(page, 'rt-servicepoints')).toBeVisible();
  await expect(last(page, 'rt-servicepoints')).toContainText('near your home');
  await expect(last(page, 'rt-servicepoints').getByTestId('rt-sp-sp-3')).toHaveCount(0);                // sp-3 handles refunds only
});

test('R6 changing the delivery address after the summary recalculates and outdates the old summary', async ({ page }) => {
  await openRetail(page);
  await toConfirm(page);
  const old = last(page, 'rt-confirm');
  await expect(old.getByTestId('rt-c-fee')).toContainText('¥0.00');
  await say(page, 'Actually ship it to my company');
  await expect(last(page, 'rt-address').getByTestId('rt-recalc-exchange')).toContainText('Total ¥10.00');
  await expect(page.getByTestId('rt-confirm')).toHaveCount(2);
  await expect(page.getByTestId('rt-confirm').first().getByTestId('rt-confirm-stale')).toHaveText('Updated');
  await expect(page.getByTestId('rt-confirm').first().getByTestId('rt-submit')).toBeDisabled();
  await expect(last(page, 'rt-confirm').getByTestId('rt-c-fee')).toContainText('¥10.00');
  await expect(last(page, 'rt-confirm').getByTestId('rt-c-delivery')).toContainText('Innovation Rd');
  await expect(last(page, 'rt-confirm').getByTestId('rt-c-pickup')).toContainText('1 Example Rd');       // pickup address untouched
  await expect(page.getByTestId('rt-receipt')).toHaveCount(0);
});

test('R7 not understood: a specific question in context, never a generic "use the cards" reply', async ({ page }) => {
  await openRetail(page);
  await toPlans(page);
  await say(page, 'Exchange please');
  await say(page, 'hmm, what now?');
  const t = agentText(page).last();
  await expect(t).toContainText('I did not quite catch that.');
  await expect(t).toContainText('drop the old item off yourself, or have a courier collect it');
  await expect(page.locator('body')).not.toContainText(/another way|no updates|cards below/i);
});

test('R8 a refund has no delivery address: "ship to my company" is clarified, not applied', async ({ page }) => {
  await openRetail(page);
  await toPlans(page);
  await say(page, 'I choose the refund');
  await say(page, 'Please ship it to my company');
  await expect(agentText(page).last()).toContainText('A refund does not need a delivery address');
  await expect(page.getByTestId('rt-address')).toHaveCount(0);
});

test('R9 no company address: a form appears only now, and needs map point, door number, floor and phone', async ({ page }) => {
  await openRetail(page, 'no_company');
  await toPlans(page);
  await say(page, 'Exchange, ship it to my company');
  const a = last(page, 'rt-address');
  await expect(a.getByTestId('rt-addr-incomplete')).toBeVisible();
  await expect(a.getByTestId('rt-addr-save')).toBeDisabled();
  await a.getByTestId('rt-address-map').scrollIntoViewIfNeeded();
  const box = (await a.getByTestId('rt-address-map').locator('svg').boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.68, box.y + box.height * 0.4);                           // pick a point (suburb ring)
  await expect(a.getByTestId('rt-address-map-pin-picked')).toBeVisible();                               // the click registered
  await a.getByTestId('rt-addr-recipient').fill('Demo User');
  await a.getByTestId('rt-addr-phone').fill('000-0000-0009');
  await a.getByTestId('rt-addr-detail').fill('9 Test Rd, Example New District (demo address)');
  await expect(a.getByTestId('rt-addr-save')).toBeDisabled();                                            // floor/room still missing
  await a.getByTestId('rt-addr-floor').fill('Floor 5, Room 502');
  await a.getByTestId('rt-addr-save').click();
  await expect(a.getByTestId('rt-recalc-exchange')).toContainText('Total ¥10.00');
  await expect(a.getByTestId('rt-recalc-exchange')).toContainText('Nov 16');
});

test('R10 several company addresses must be chosen; a remote one makes the exchange late and says so', async ({ page }) => {
  await openRetail(page, 'multi_company');
  await toPlans(page);
  await say(page, 'Exchange, ship it to my company');
  const a = last(page, 'rt-address');
  await expect(a.getByTestId('rt-recalc')).toContainText('No new address chosen yet');
  await a.getByTestId('rt-addr-opt-company-2').locator('input').check();
  await expect(a.getByTestId('rt-recalc-exchange')).toContainText('Will likely miss the date');
  await expect(a.getByTestId('rt-recalc-exchange')).toContainText('Nov 19');
  await a.getByTestId('rt-addr-opt-company-1').locator('input').check();
  await expect(a.getByTestId('rt-recalc-exchange')).toContainText('Should arrive in time');
});

test('R11 no plan can meet the date: stated plainly, no recommendation', async ({ page }) => {
  await openRetail(page);
  await toPlans(page, { deadline: '2026-11-13' });
  const p = last(page, 'rt-plans');
  await expect(p.getByTestId('rt-rec-text')).toContainText('No plan can get');
  await expect(p.getByTestId('rt-rec-text')).toContainText('not recommending');
  await expect(p.getByTestId('rt-recommended')).toHaveCount(0);
  await expect(p.getByTestId('rt-timing-exchange')).toHaveText('Will likely miss the date');
});

test('R12 out-of-warranty item: reasons are shown on the plans, only repair is possible', async ({ page }) => {
  await openRetail(page);
  await toPlans(page, { who: 'The second one, my left side has no sound' });
  const p = last(page, 'rt-plans');
  await expect(page.getByTestId('rt-orders-value')).toContainText('out of warranty');
  await expect(p.getByTestId('rt-reason-exchange')).toContainText('Out of warranty');
  await expect(p.getByTestId('rt-reason-refund')).toContainText('Out of warranty');
  await expect(p.getByTestId('rt-fees-repair')).toContainText('Service fee ¥129.00');
  await expect(p.getByTestId('rt-plan-radio-exchange')).toBeDisabled();
  expect(O2).toContain('0733');
});

test('R13 submit failure keeps the answers, says nothing was created, and a safe retry makes one case', async ({ page }) => {
  await openRetail(page, 'submit_fail');
  await toConfirm(page);
  const cf = last(page, 'rt-confirm');
  await cf.getByTestId('rt-submit').click();
  await expect(cf.getByTestId('rt-submit-error')).toContainText('Request not created');
  await expect(page.getByTestId('rt-receipt')).toHaveCount(0);                                           // failure never shows success
  await expect(cf.getByTestId('rt-c-plan')).toHaveText('Exchange');                                      // content kept
  await cf.getByTestId('rt-submit').click();                                                             // "Retry submit"
  await expect(page.getByTestId('rt-receipt')).toHaveCount(1);
});

test('R14 replaying the submit request (same key, or a new key with identical content) never makes a second case', async ({ page, request }) => {
  await openRetail(page);
  await toConfirm(page);
  const sent = page.waitForRequest('**/api/retail/submit');
  await last(page, 'rt-confirm').getByTestId('rt-submit').click();
  const body = JSON.parse((await sent).postData()!) as { key: string };
  await expect(page.getByTestId('rt-receipt')).toHaveCount(1);
  const id = await page.getByTestId('rt-r-id').innerText();
  const again = await (await request.post('/api/retail/submit', { data: body })).json();
  const newKey = await (await request.post('/api/retail/submit', { data: { ...body, key: `${body.key.split(':')[0]}:replay` } })).json();
  expect([again.ok, again.duplicate, again.record.id]).toEqual([true, true, id]);
  expect([newKey.ok, newKey.duplicate, newKey.record.id]).toEqual([true, true, id]);
  const noConfirm = await (await request.post('/api/retail/submit', { data: { ...body, key: 'fresh-session:1', confirmed: false } })).json();
  expect([noConfirm.ok, noConfirm.created]).toEqual([false, false]);                                     // not confirmed -> nothing created
});

test('R15 changing the time or the plan from the summary makes the old summary stale and re-asks only that', async ({ page }) => {
  await openRetail(page);
  await toConfirm(page);
  const cf = last(page, 'rt-confirm');
  await expect(cf.getByTestId('rt-submit')).toBeEnabled();
  await cf.getByRole('button', { name: 'Change time' }).click();
  await expect(cf.getByTestId('rt-confirm-stale')).toHaveText('Updated');
  await expect(cf.getByTestId('rt-submit')).toBeDisabled();
  await expect(page.getByTestId('rt-receipt')).toHaveCount(0);
  await expect(page.getByTestId('rt-pickup')).toHaveCount(1);                                            // asked again: only the newest card is shown
  await last(page, 'rt-pickup-date').fill('2026-11-14');
  await last(page, 'rt-slot-09:00-12:00').click();
  await expect(page.getByTestId('rt-confirm')).toHaveCount(2);
  await expect(last(page, 'rt-confirm').getByTestId('rt-submit')).toBeEnabled();
  await expect(last(page, 'rt-confirm').getByTestId('rt-c-pickup')).toContainText('2026-11-14');
});

test('R16 changing the plan twice leaves one plan line, never claims "Submitted" early, and refined estimates do not hide the choice', async ({ page }) => {
  await openRetail(page);
  await toPlans(page);
  await last(page, 'rt-plans').getByTestId('rt-plan-radio-exchange').click();
  await page.getByTestId('rt-plans-change').click();                       // "Change" on the plan line asks again
  await expect(page.getByTestId('rt-plans')).toHaveCount(1);                // the old answered copy is gone, only the new card shows
  await last(page, 'rt-plans').getByTestId('rt-plan-radio-repair').click();
  await expect(page.getByTestId('rt-plans-value')).toContainText('Repair');
  await quick(page, 'Courier pickup').click();
  await last(page, 'rt-pickup-date').fill('2026-11-14');                   // a later pickup date moves the repair estimate
  await last(page, 'rt-slot-09:00-12:00').click();
  await expect(page.getByTestId('rt-plans-value')).toContainText('Repair · estimated delivery Nov 22');   // 11-14 +1 +5 +2 days, hand-computed
  await expect(page.getByTestId('rt-plans')).toHaveCount(1);
  await expect(page.locator('body')).not.toContainText('Submitted');       // nothing was submitted
  await expect(page.locator('body')).not.toContainText('Earlier comparison');
  await last(page, 'rt-confirm').getByTestId('rt-submit').click();
  await expect(page.getByTestId('rt-receipt')).toHaveCount(1);
  await expect(page.getByTestId('rt-confirm-stale')).toHaveText('Submitted');   // only the summary that was submitted says so
});

// ---------------- natural-language tracing: browser Send -> /api/retail/interpret -> model ----------------
const OK_TRACE = (requestId: string, turn: Record<string, unknown> = {}) => ({ requestId, at: 'mock', mode: 'live', messageChars: 10, contextChars: 10, modelCalled: true, model: 'deepseek-chat', httpStatus: 200, ttfbMs: 90, modelMs: 640, budgetReservation: 1,
  calls: [{ stage: 'plan', modelCalled: true, httpStatus: 200, ttfbMs: 90, modelMs: 640, budgetReservation: 1, failure: null }],
  turn: { mode: 'change', tools: [], ui: [], guardOk: true, answerReplaced: false, ignoredChanges: false, changeKeys: [], ...turn }, outcome: 'ok', failure: null, totalMs: 650 });
const TURN = (requestId: string, plan: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ kind: 'turn', plan: { mode: 'change', changes: {}, answer: '', ui: [], quick: [], ...plan }, results: [], memo: '', guard: { ok: true, violations: [], replaced: false }, ignoredChanges: false, trace: OK_TRACE(requestId, { mode: (plan.mode as string) ?? 'change' }), ...extra });
const mockInterpret = (page: Page, make: (requestId: string, body: { message: string; history: { role: string; text: string; memo?: string }[]; task: { delivery: { id: string }; planId: string | null } }) => unknown) =>
  page.route('**/api/retail/interpret', async (r) => { const id = r.request().headers()['x-request-id']; await r.fulfill({ json: make(id, JSON.parse(r.request().postData()!)) as object }); });

test('R17 model mode, model unavailable: says so, changes nothing, never shows "Understood by model", offers retry or an explicit rules choice', async ({ page }) => {
  await openRetail(page, undefined, 'model');                                                           // server is in stub-fail mode: it sends no model request
  await page.getByTestId('rt-sample').click();
  const bubble = page.getByTestId('rt-user-msg').last();
  await expect(bubble.getByTestId('rt-via')).toHaveText('Model call failed, nothing was understood');
  await expect(bubble.getByTestId('rt-trace-line')).toContainText('model NOT called');
  await expect(bubble.getByTestId('rt-trace-line')).toContainText('failure: stub-fail');
  await expect(page.getByText('Understood by model')).toHaveCount(0);
  await expect(page.getByTestId('rt-orders')).toHaveCount(0);                                            // nothing was silently understood
  await expect(agentText(page).last()).toContainText('Nothing was changed');
  const firstId = (await bubble.getByTestId('rt-trace-line').innerText()).split(' · ')[0];
  await quick(page, 'Retry with the model').click();                                                     // a retry is a NEW request with its own id
  await expect(page.getByTestId('rt-trace-line').last()).toContainText('failure: stub-fail');
  const secondId = (await page.getByTestId('rt-trace-line').last().innerText()).split(' · ')[0];
  expect(secondId).not.toBe(firstId);
  await expect(page.getByTestId('rt-orders')).toHaveCount(0);
  await quick(page, 'Use basic rules for this message').last().click();                                  // the user's explicit choice
  await expect(page.getByTestId('rt-user-msg').last().getByTestId('rt-via')).toHaveText('Understood by rules (you chose rules after the model failed)');
  await expect(last(page, 'rt-orders')).toBeVisible();
  await page.getByTestId('rt-trace-toggle').click();
  await expect(page.getByTestId('rt-trace-row')).toHaveCount(3);
  await expect(page.getByTestId('rt-trace-panel')).toContainText('retry of');
});

test('R18 model mode, model answered: label shown only because the server proves a call; buttons add no model calls', async ({ page }) => {
  let calls = 0;
  await openRetail(page, undefined, 'model');
  await mockInterpret(page, (id) => { calls++; return TURN(id, { mode: 'change', changes: { orderHint: 'headphones', tripNextWeek: true } }); });   // a MOCKED server answer: tests the UI wiring only
  await page.getByTestId('rt-sample').click();
  const bubble = page.getByTestId('rt-user-msg').last();
  await expect(bubble.getByTestId('rt-via')).toHaveText('Understood by model');
  await expect(bubble.getByTestId('rt-trace-line')).toContainText('model called (deepseek-chat, HTTP 200)');
  await expect(bubble.getByTestId('rt-trace-line')).toContainText('model 640 ms (first byte 90 ms)');
  await expect(bubble.getByTestId('rt-trace-line')).toContainText('round trip');
  await expect(last(page, 'rt-orders')).toBeVisible();
  await last(page, 'rt-orders').getByTestId(`rt-order-${O1}`).locator('input').click();                  // component choice
  await last(page, 'rt-symptoms').getByTestId('rt-symptom-charging').check();
  await last(page, 'rt-symptoms').getByTestId('rt-symptoms-done').click();
  await expect(page.getByTestId('rt-user-msg').filter({ hasText: 'Quick action' }).first()).toBeVisible();
  expect(calls).toBe(1);                                                                                 // only the typed sentence reached /api/retail/interpret
});

test('R19 a server answer that claims success without a model call is rejected, not shown as "Understood by model"', async ({ page }) => {
  await openRetail(page, undefined, 'model');
  await mockInterpret(page, (id) => TURN(id, { mode: 'change', changes: { orderHint: 'headphones' } }, { trace: { ...OK_TRACE(id), modelCalled: false, model: null, httpStatus: null } }));
  await page.getByTestId('rt-sample').click();
  const bubble = page.getByTestId('rt-user-msg').last();
  await expect(bubble.getByTestId('rt-via')).toHaveText('Model call failed, nothing was understood');
  await expect(bubble.getByTestId('rt-trace-line')).toContainText('server_claimed_success_without_a_model_call');
  await expect(page.getByText('Understood by model')).toHaveCount(0);
  await expect(page.getByTestId('rt-orders')).toHaveCount(0);
});

test('R20 the request id travels browser -> server -> trace record; the record has no message text and no key', async ({ page, request }) => {
  await openRetail(page, undefined, 'model');
  const secret = 'ZZ-unique-message-text-for-the-trace-test';
  const sent = page.waitForRequest('**/api/retail/interpret');
  const got = page.waitForResponse('**/api/retail/interpret');
  await page.getByTestId('rt-question').fill(secret);
  await page.getByTestId('rt-ask').click();
  const req = await sent;
  const headerId = req.headers()['x-request-id'];
  expect(headerId).toMatch(/^rq-[a-z0-9]+-[a-z0-9]{4}$/);
  expect(JSON.parse(req.postData()!).requestId).toBe(headerId);
  const res = await got;
  expect(res.headers()['x-request-id']).toBe(headerId);
  const body = await res.json();
  expect(body.trace).toMatchObject({ requestId: headerId, modelCalled: false, mode: 'stub-fail', outcome: 'failed' });
  await expect(page.getByTestId('rt-trace-line').last()).toContainText(headerId);
  const rec = await (await request.get(`/api/retail/trace?requestId=${headerId}`)).json();       // the server's own copy
  expect(rec.traces).toHaveLength(1);
  expect(rec.traces[0]).toMatchObject({ requestId: headerId, modelCalled: false, mode: 'stub-fail', messageChars: secret.length });
  expect(JSON.stringify(rec)).not.toContain(secret);
  expect(JSON.stringify(rec)).not.toMatch(/sk-[A-Za-z0-9]{8,}|authorization|bearer|DEEPSEEK_API/i);
});

test('R21 rules-only mode: no request is sent, the message says it, and the trace panel records it', async ({ page }) => {
  let calls = 0;
  await openRetail(page, undefined, 'rules');
  page.on('request', (r) => { if (r.url().includes('/api/retail/interpret')) calls++; });
  await say(page, SAMPLE);
  await expect(page.getByTestId('rt-user-msg').last().getByTestId('rt-trace-line')).toContainText('rules-only mode: model NOT called');
  expect(calls).toBe(0);
  await page.getByTestId('rt-trace-toggle').click();
  await expect(page.getByTestId('rt-trace-row')).toHaveCount(1);
  await expect(page.getByTestId('rt-trace-row')).toContainText('rules_only');
});

// ---------------- v0.4.0: explain, hypothetical, explicit adoption (server answers are MOCKED here: this tests the UI wiring and that state is not mutated; the facts themselves are unit-tested with hand-computed numbers and checked against the real model in the live run) ----------------
const QUOTE_HOME = (applyIntent: unknown) => ({ id: 'q1', tool: 'quote_plans', assumptions: ['delivery to Home (Urban)'], deadline: '2026-11-16', deadlineText: 'Nov 16', applyIntent, rows: [
  { plan: 'exchange', label: 'Exchange', eligible: true, reason: null, etaNow: 'Nov 16', etaNowDate: '2026-11-16', etaAlt: 'Nov 15', etaAltDate: '2026-11-15', etaLabel: 'Estimated delivery', deltaDays: -1, totalNow: '¥10.00', totalNowCents: 1000, totalAlt: '¥0.00', totalAltCents: 0, deltaCents: -1000, refund: null, refundCents: null, timingNow: 'on_time', timingAlt: 'on_time', marginAltDays: 1 },
  { plan: 'repair', label: 'Repair', eligible: true, reason: null, etaNow: 'Nov 20', etaNowDate: '2026-11-20', etaAlt: 'Nov 19', etaAltDate: '2026-11-19', etaLabel: 'Estimated delivery', deltaDays: -1, totalNow: '¥0.00', totalNowCents: 0, totalAlt: '¥0.00', totalAltCents: 0, deltaCents: 0, refund: null, refundCents: null, timingNow: 'late', timingAlt: 'late', marginAltDays: -3 }] });
/** conversation by rules up to: exchange chosen, delivery = company, then switch to the model for the questions */
async function toCompanyThenModel(page: Page) {
  await openRetail(page, undefined, 'rules');
  await toPlans(page);
  await say(page, 'Exchange, ship it to my company');
  await expect(last(page, 'rt-address').getByTestId('rt-addr-summary')).toContainText('Company · Example Tower');
  await page.getByTestId('rt-interpreter').selectOption('model');
}

test('R22 a question gets an answer plus the evidence; a hypothetical changes nothing; adoption is explicit and reports what changed and what stayed', async ({ page }) => {
  await toCompanyThenModel(page);
  let bodySeen: { history: { role: string; text: string; memo?: string }[]; task: { delivery: { id: string }; planId: string | null } } | null = null;
  const replies: ((id: string) => unknown)[] = [
    (id) => TURN(id, { mode: 'what_if', changes: { deliveryTarget: 'home' }, answer: 'Delivering to your home would bring the exchange to Nov 15, 1 day earlier, and ¥0.00 instead of ¥10.00.', ui: [{ component: 'compare', query: 'q1' }] },
      { results: [QUOTE_HOME({ deliveryTarget: 'home' })], memo: '[comparison q1: delivery to Home (Urban) | applying it would be {"deliveryTarget":"home"} | Exchange Nov 15 ¥0.00]', ignoredChanges: true, trace: OK_TRACE(id, { mode: 'what_if', tools: ['quote_plans'], ui: ['compare'], ignoredChanges: true }) }),
    (id) => TURN(id, { mode: 'change', changes: { deliveryTarget: 'home' }, answer: '' }),
  ];
  await mockInterpret(page, (id, body) => { bodySeen = body; return replies.shift()!(id); });
  // 1. hypothetical: answered, shown as a comparison, state untouched
  await say(page, 'If I ship it home instead, how much sooner? Do not change the address yet.');
  await expect(agentText(page).last()).toContainText('1 day earlier');
  const cmp = last(page, 'rt-compare');
  await expect(cmp.getByTestId('rt-compare-badge')).toHaveText('What-if only · nothing was changed');
  await expect(cmp.getByTestId('rt-compare-row-exchange')).toContainText('Nov 16 · ¥10.00');
  await expect(cmp.getByTestId('rt-compare-row-exchange')).toContainText('Nov 15 · ¥0.00');
  await expect(cmp.getByTestId('rt-compare-row-exchange')).toContainText('1 day earlier · ¥10.00 less');
  await expect(cmp.getByTestId('rt-compare-row-repair')).toContainText('misses your deadline by 3 days');
  await expect(page.getByTestId('rt-trace-line').last()).toContainText('what_if · tools quote_plans · ui compare · state changes ignored');
  expect(bodySeen!.task.delivery.id).toBe('company-1');                                                // what the model was told
  await expect(page.getByTestId('rt-address-value').last()).toContainText('Company · Example Tower');   // still the company address (the card collapsed to its summary line)
  await expect(page.getByText(/^Changed:/)).toHaveCount(0);
  await expect(page.getByTestId('rt-receipt')).toHaveCount(0);
  // 2. "use the one we just compared, keep everything else": the model sees the app's memo of the comparison; the change is applied and reported
  await say(page, 'Use the home address we just compared, keep everything else the same.');
  expect(bodySeen!.history.some((h) => h.memo?.includes('{"deliveryTarget":"home"}'))).toBe(true);
  const changed = page.getByText(/^Changed:/);
  await expect(changed).toContainText('Delivery address: Company · Example Tower → Home');
  await expect(changed).not.toContainText('Plan:');                                                    // the plan was not touched
  await expect(changed).toContainText('Unchanged:');
  await expect(changed).toContainText('Plan');
  await expect(changed).toContainText('Latest receive date');
});

test('R23 "Apply this change" on a comparison is the explicit adoption; the button is the only thing that changes the address', async ({ page }) => {
  await toCompanyThenModel(page);
  await mockInterpret(page, (id) => TURN(id, { mode: 'what_if', answer: 'Home would be 1 day earlier (Nov 15).', ui: [{ component: 'compare', query: 'q1' }] }, { results: [QUOTE_HOME({ deliveryTarget: 'home' })] }));
  await say(page, 'What if it went home?');
  await expect(page.getByTestId('rt-address-value').last()).toContainText('Company · Example Tower');
  await last(page, 'rt-compare').getByTestId('rt-compare-apply').click();
  await expect(page.getByText(/^Changed:/)).toContainText('Delivery address: Company · Example Tower → Home');
  await expect(last(page, 'rt-address').getByTestId('rt-addr-summary')).toContainText('Home');
  await expect(page.getByTestId('rt-user-msg').last().getByTestId('rt-via')).toHaveText('Quick action (direct, no model)');
});

test('R24 a service-point comparison offers "Use this one"; an appointment-only point is not bookable without a slot and cannot be submitted', async ({ page }) => {
  await openRetail(page, undefined, 'rules');
  await toPlans(page);
  await say(page, 'Exchange, drop it off myself, near my company');
  await last(page, 'rt-servicepoints').getByTestId('rt-sp-sp-2').locator('input').click();            // sp-2: appointment required
  const d = last(page, 'rt-dropdate');
  await expect(d.getByTestId('rt-appt-note')).toContainText('needs an appointment');
  await d.getByTestId('rt-dropdate-date-input').fill('2026-11-13');
  await expect(d.getByTestId('rt-appt-18:00-20:00')).toBeDisabled();                                   // full: (13+2)%5==0
  await expect(page.getByTestId('rt-confirm')).toHaveCount(0);                                         // a date alone does not book it, and there is no summary to submit
  await d.getByTestId('rt-appt-14:00-18:00').click();
  const cf = last(page, 'rt-confirm');
  await expect(cf.getByTestId('rt-c-pickup')).toContainText('You drop it off · 2026-11-13 14:00-18:00');
  await expect(cf.getByTestId('rt-c-pickup')).toContainText('Appointment booked');
  await cf.getByTestId('rt-submit').click();
  const rc = page.getByTestId('rt-receipt');
  await expect(rc.getByTestId('rt-r-pickup')).toContainText('14:00-18:00');
  await expect(rc).toContainText('you drop off the old unit');                                          // not "picked up"
  await expect(rc).not.toContainText('picked up');
});
