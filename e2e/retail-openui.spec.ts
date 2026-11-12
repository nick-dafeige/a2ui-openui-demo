import { expect, test, type Page } from '@playwright/test';
import { runUiEvent, runUiTurn } from '../src/retail/openui/compose.ts';
import { buildServerTrace } from '../src/retail/trace.ts';
import { parseHistory, parseTask, type ModelCall } from '../src/retail/turn.ts';

/**
 * v0.5.0 vertical slice, OFFLINE. The MODEL is scripted here (its Lang text is written by the test), but everything else is the
 * real application: planning-turn handling, binding bundle, Lang validation, the OpenUI Renderer, semantic events, the state
 * reducer, staleness, and the real simulated submit service. This proves wiring and safety, not model quality (see e2e-live).
 */
const last = (page: Page, id: string) => page.getByTestId(id).last();
const say = async (page: Page, text: string) => { await page.getByTestId('rt-question').fill(text); await page.getByTestId('rt-ask').click(); };
const SAMPLE_TO_PLANS = async (page: Page) => {
  await page.getByTestId('rt-sample').click();
  await last(page, 'rt-orders').getByTestId('rt-order-RT-20260620-1001').locator('input').click();
  await last(page, 'rt-symptoms').getByTestId('rt-symptom-one_side_silent').check();
  await last(page, 'rt-symptoms').getByTestId('rt-symptoms-done').click();
  await last(page, 'rt-deadline-date-input').fill('2026-11-16'); await last(page, 'rt-deadline-date-confirm').click();
  await expect(last(page, 'rt-plans')).toBeVisible();
};
type Script = { plan?: unknown; lang: string[] };
async function mockModel(page: Page, scripts: Script[]) {
  const seen: { stages: string[]; body: Record<string, unknown> }[] = [];
  await page.route('**/api/retail/interpret', async (route) => {
    const body = route.request().postDataJSON() as { message: string; history: unknown; task: unknown; requestId: string; ui?: string; event?: { report: string | null; notes: string } };
    const s = scripts.shift();
    if (!s) { await route.fulfill({ json: { kind: 'failed', reason: 'test_script_exhausted', trace: null } }); return; }
    const stages: string[] = []; let li = 0;
    const call: ModelCall = async (stage) => { stages.push(stage); if (stage === 'plan') return JSON.stringify(s.plan ?? {}); return s.lang[li++] ?? ''; };
    const task = parseTask(body.task)!; const history = parseHistory(body.history);
    const outcome = body.event ? await runUiEvent({ message: body.message, history, task, report: body.event.report, notes: body.event.notes }, call) : await runUiTurn({ message: body.message, history, task }, call);
    const calls = stages.map((stage) => ({ stage: stage as 'plan', events: [{ stage: 'sent' as const }, { stage: 'response' as const, status: 200, ms: 5 }, { stage: 'done' as const, ms: 5 }] }));
    const trace = buildServerTrace({ requestId: body.requestId, at: 'mock', mode: 'live', messageChars: body.message.length, contextChars: 10, calls, outcome: outcome.kind === 'turn' ? outcome : { kind: 'failed', reason: outcome.reason }, model: 'MOCKED-model', totalMs: 10 });
    seen.push({ stages, body });
    const { stages: _s, ...rest } = outcome as typeof outcome & { stages?: unknown };
    await route.fulfill({ json: { ...rest, trace } });
  });
  return seen;
}
async function toCompanyThenModel(page: Page) {
  await page.goto('/'); await page.getByTestId('mode-retail').click();
  await page.getByTestId('rt-interpreter').selectOption('rules');
  await SAMPLE_TO_PLANS(page);
  await say(page, 'Exchange, ship it to my company');
  await expect(last(page, 'rt-address').getByTestId('rt-addr-summary')).toContainText('Company · Example Tower');
  await page.getByTestId('rt-interpreter').selectOption('model');
  await expect(page.getByTestId('rt-ui-mode')).toHaveValue('openui');
}
const GOOD_COMPARE = `root = Stack([t, cmp, q])
t = Text("Delivering to your home would arrive on Nov 15 instead of Nov 16 and cost ¥10.00 less. Nothing has been changed yet.")
cmp = QuoteComparison("cmp.q1")
q = QuickReply("Use the home address", "adopt", "cmp.q1")`;
const WHAT_IF_HOME = { mode: 'what_if', queries: [{ id: 'q1', tool: 'quote_plans', args: { delivery: 'home' } }] };

test('V1 explain -> home what-if -> adopt -> store appointment -> submit: every interface is model-written Lang, validated, rendered by OpenUI', async ({ page }) => {
  await toCompanyThenModel(page);
  const seen = await mockModel(page, [
    { plan: { mode: 'discuss' }, lang: [`root = Stack([t, m])
t = Text("An exchange suits your trip because the replacement ships first, so you are not left without headphones while the old unit travels back. It is estimated to arrive Nov 16.")
m = QuoteMetric("quote.now.exchange", "eta")`] },
    { plan: WHAT_IF_HOME, lang: [GOOD_COMPARE] },
    { lang: [`root = Stack([t, c])
t = Text("How should the old unit come back to us?")
c = SingleChoice("returnMethod", ["method.courier", "method.store"], "Return method")`] },
    { lang: [`root = Stack([t, c])
t = Text("Where should I look for a service point?")
c = SingleChoice("locationPref", ["loc.home", "loc.company"], "Search near")`] },
    { lang: [`root = Stack([t, m, c])
t = Text("These service points can take an exchange.")
m = Map(["addr.company-1", "sp.sp-1", "sp.sp-2"])
c = SingleChoice("servicePoint", ["sp.sp-1", "sp.sp-2"], "Service points")`] },
    { lang: [`root = Stack([t, f])
t = Text("This store needs an appointment. Pick a day and a time window.")
f = Form("Book your visit", [d, s], "Book it")
d = DatePicker("pickupDate")
s = TimeSlotPicker()`] },
  ]);

  // 1. a question is answered directly, with an application figure; nothing changes
  await say(page, 'Why is exchange a good fit for my trip?');
  await expect(last(page, 'rt-lang').getByTestId('ou-text')).toContainText('replacement ships first');
  await expect(last(page, 'rt-lang').getByTestId('ou-metric')).toContainText('Nov 16');
  await expect(page.getByTestId('rt-user-msg').last().getByTestId('rt-via')).toHaveText('Understood by model');
  await expect(page.getByTestId('rt-trace-line').last()).toContainText('OpenUI Lang validated');
  expect(seen[0].stages).toEqual(['plan', 'lang']);
  await expect(page.getByText(/^Changed:/)).toHaveCount(0);
  // the raw program and the library version are inspectable
  await last(page, 'rt-lang-source').locator('summary').click();
  await expect(last(page, 'rt-lang-raw')).toContainText('root = Stack([t, m])');
  await expect(last(page, 'rt-lang-source')).toContainText('retail-ui-lib/1');

  // 2. a hypothetical: comparison + adopt button; the address is still the company
  await say(page, 'What if I had it sent to my home instead?');
  const cmp = last(page, 'ou-compare');
  await expect(cmp.getByTestId('ou-whatif-badge')).toHaveText('What-if only · nothing was changed');
  await expect(cmp.getByTestId('ou-cmp-row-exchange')).toContainText('Nov 16 · ¥10.00');
  await expect(cmp.getByTestId('ou-cmp-row-exchange')).toContainText('Nov 15 · ¥0.00');
  await expect(cmp.getByTestId('ou-cmp-row-exchange')).toContainText('1 day earlier · ¥10.00 less');
  expect(seen[1].stages).toEqual(['plan', 'lang']);
  await expect(page.getByText(/^Changed:/)).toHaveCount(0);
  await expect(page.getByTestId('rt-address-value').last()).toContainText('Company · Example Tower');

  // 3. adopting is the explicit act: only the delivery address changes, then the model composes the next question
  const adopt = last(page, 'rt-lang').getByTestId('ou-quick');
  await expect(adopt).toBeEnabled();
  await adopt.click();
  await expect(page.getByText(/^Changed:/)).toContainText('Delivery address: Company · Example Tower → Home');
  await expect(page.getByText(/^Changed:/)).not.toContainText('Plan:');
  await expect(page.getByText(/^Changed:/)).toContainText('Unchanged:');
  expect(seen[2].stages).toEqual(['lang']);                                                              // a pressed control costs ONE model call (no planning step)
  // the old what-if is frozen: facts kept, control switched off
  const old = page.getByTestId('rt-lang').nth(1);
  await expect(old).toHaveAttribute('data-live', 'false');
  await expect(old.getByTestId('rt-lang-stale')).toBeVisible();
  await expect(old.getByTestId('ou-cmp-row-exchange')).toContainText('Nov 15 · ¥0.00');
  await expect(old.getByTestId('ou-quick')).toBeDisabled();

  // 4. "I drop it off" -> where to look -> the point -> an appointment (date + slot in ONE form)
  await last(page, 'rt-lang').getByTestId('ou-opt-method.store').click();
  await last(page, 'rt-lang').getByTestId('ou-opt-loc.company').click();
  await expect(last(page, 'rt-lang').getByTestId('ou-map')).toBeVisible();
  await expect(last(page, 'rt-lang').getByTestId('ou-gmap').locator('iframe')).toHaveAttribute('src', /^https:\/\/maps\.google\.com\/maps\?q=[0-9.]+,[0-9.]+&z=14&output=embed$/);
  await page.waitForTimeout(2500); await page.screenshot({ path: 'evidence/v0.5.0-20261111/gmap-embed.png' });
  await expect(last(page, 'rt-lang').getByTestId('ou-opt-sp.sp-3')).toHaveCount(0);                      // West Pickup Point only handles refunds
  await last(page, 'rt-lang').getByTestId('ou-opt-sp.sp-2').click();
  const form = last(page, 'ou-form');
  await expect(form.getByTestId('ou-form-submit')).toBeDisabled();
  await form.getByTestId('ou-date-input-pickupDate').fill('2026-11-13');
  await expect(form.getByTestId('ou-slot-09:00-12:00')).toHaveCount(0);                                    // the store opens at 10:00: never offered
  await expect(form.getByTestId('ou-slot-18:00-20:00')).toBeDisabled();                                    // full on the 13th
  await form.getByTestId('ou-slot-14:00-18:00').click();
  await expect(form.getByTestId('ou-form-submit')).toBeEnabled();
  await form.getByTestId('ou-form-submit').click();
  expect(seen.map((s) => s.stages.join('+'))).toEqual(['plan+lang', 'plan+lang', 'lang', 'lang', 'lang', 'lang']);   // the last press needs no model call: the application shows its own summary

  // 5. the application's own confirmation; submission is only its button
  const cf = last(page, 'rt-confirm');
  await expect(cf).toContainText('New District Store');
  await expect(cf).toContainText('14:00-18:00');
  await expect(page.getByTestId('rt-receipt')).toHaveCount(0);
  await cf.getByTestId('rt-submit').click();
  const rc = last(page, 'rt-receipt');
  await expect(rc).toBeVisible();
  await expect(rc).toContainText('you drop off the old unit');
  await expect(rc).toContainText('Appointment booked');
  await expect(rc).not.toContainText('picked up');
  await expect(rc).toContainText('14:00-18:00');
});

test('V2 a program with a made-up figure or an unknown component is rejected after one repair; the user is told and gets the standard card, no state change', async ({ page }) => {
  await toCompanyThenModel(page);
  const seen = await mockModel(page, [
    { plan: WHAT_IF_HOME, lang: ['root = Stack([a])\na = Text("Home would cost only ¥3.00 more.")', 'root = Stack([a])\na = Carousel("x")'] },
  ]);
  await say(page, 'What if I had it sent to my home instead?');
  expect(seen[0].stages).toEqual(['plan', 'lang', 'repair']);
  await expect(page.getByTestId('rt-lang-rejected')).toBeVisible();
  await expect(page.getByTestId('rt-agent-msg').filter({ hasText: 'rejected by the application' }).last()).toContainText('attempt1: figure_not_in_facts');
  await expect(page.getByTestId('ou-compare')).toHaveCount(0);
  await expect(page.getByTestId('rt-address-value').last()).toContainText('Company · Example Tower');
  await last(page, 'rt-lang-source').locator('summary').click();
  await expect(last(page, 'rt-lang-errors')).toContainText('unknown_component:Carousel');
  await expect(page.getByTestId('rt-trace-line').last()).toContainText('OpenUI Lang REJECTED');
});

test('V3 an invalid first program is repaired once and then shown; the repair is a counted second Lang call', async ({ page }) => {
  await toCompanyThenModel(page);
  const seen = await mockModel(page, [{ plan: WHAT_IF_HOME, lang: ['root = Stack([a])\na = QuoteComparison("cmp.q9")', GOOD_COMPARE] }]);
  await say(page, 'What if I had it sent to my home instead?');
  expect(seen[0].stages).toEqual(['plan', 'lang', 'repair']);
  await expect(last(page, 'ou-compare')).toBeVisible();
  await expect(page.getByTestId('rt-trace-line').last()).toContainText('validated after 1 repair');
});

test('V4 a failed model call shows the failure and keeps the previous state (no silent fallback)', async ({ page }) => {
  await toCompanyThenModel(page);
  await mockModel(page, []);                                    // script exhausted -> the server answers "failed"
  await say(page, 'What if I had it sent to my home instead?');
  await expect(page.getByTestId('rt-user-msg').last().getByTestId('rt-via')).toHaveText('Model call failed, nothing was understood');
  await expect(page.getByTestId('rt-agent-msg').last()).toContainText('Nothing was changed');
  await expect(page.getByTestId('rt-lang')).toHaveCount(0);
});

test('V5 a typed date and slot in one sentence reach the task without any extra click (rules path: same Intent as the form)', async ({ page }) => {
  await page.goto('/'); await page.getByTestId('mode-retail').click();
  await page.getByTestId('rt-interpreter').selectOption('rules');
  await page.getByTestId('rt-ui-mode').selectOption('cards');
  await SAMPLE_TO_PLANS(page);
  await say(page, 'Exchange, drop it off myself, near my company');
  await expect(last(page, 'rt-servicepoints')).toBeVisible();
  await say(page, 'The new district store');
  await expect(last(page, 'rt-dropdate').getByTestId('rt-appt-note')).toContainText('needs an appointment');
  await say(page, 'Nov 13, 14:00-18:00');                                      // date AND time window in one sentence: no extra click
  await expect(last(page, 'rt-confirm')).toContainText('14:00-18:00');
  await expect(last(page, 'rt-confirm')).toContainText('2026-11-13');
});
