import { describe, expect, it } from 'vitest';
import { scenarioById, type ScenarioId } from '../src/retail/data.ts';
import { applyIntent } from '../src/retail/flow.ts';
import { diffTask, initialTask, payloadOf, readiness, setPickup, setPlan, nextNeed, type TaskState } from '../src/retail/state.ts';
import { quotePlan } from '../src/retail/rules.ts';
import { buildFacts, fallbackAnswer, guardAnswer, memoOf, parseHistory, parseTask, parseTurnPlan, runQuery, runTurn, validateQuery, type ModelCall, type PointsResult, type QuoteResult, type Stage } from '../src/retail/turn.ts';

// Expected numbers are hand-computed from src/retail/data.ts and the policy in rules.ts (never taken from engine output).
const O1 = 'RT-20260620-1001';
function task(scn: ScenarioId = 'standard', o: Partial<TaskState> = {}): TaskState {
  const t = initialTask(scenarioById(scn));
  const company = t.book.find((a) => a.kind === 'company') ?? t.delivery;
  return { ...t, orderId: O1, symptoms: ['one_side_silent'], deadline: '2026-11-16', delivery: company, planId: 'exchange', ...o };   // delivering to the company address (suburb)
}
const q = (id: string, tool: 'quote_plans' | 'service_points' | 'policy_terms', args: Record<string, unknown> = {}) => ({ id, tool, args });
const quote = (t: TaskState, args: Record<string, unknown>) => runQuery(q('q1', 'quote_plans', args), t) as QuoteResult;
const row = (r: QuoteResult, plan: string) => r.rows.find((x) => x.plan === plan)!;

describe('tool quote_plans: what the plans would look like if something were different', () => {
  const t = task();
  it('now (company, suburb): exchange Nov 16 / 10.00, repair Nov 20 / 0.00', () => {
    const r = quote(t, {});
    expect(r.assumptions).toEqual(['nothing changed (current settings)']);
    expect(row(r, 'exchange')).toMatchObject({ etaNowDate: '2026-11-16', totalNowCents: 1000, timingNow: 'on_time' });
    expect(row(r, 'repair')).toMatchObject({ etaNowDate: '2026-11-20', totalNowCents: 0, timingNow: 'late' });
    expect(r.applyIntent).toBeNull();
  });
  it('if delivered home (urban): exchange 1 day earlier and 10.00 cheaper; repair 1 day earlier; refund unchanged', () => {
    const r = quote(t, { delivery: 'home' });
    expect(row(r, 'exchange')).toMatchObject({ etaAltDate: '2026-11-15', deltaDays: -1, totalAltCents: 0, deltaCents: -1000, timingAlt: 'on_time', marginAltDays: 1 });     // deadline Nov 16 minus ETA Nov 15
    expect(row(r, 'repair')).toMatchObject({ etaAltDate: '2026-11-19', deltaDays: -1, marginAltDays: -3 });
    expect(row(r, 'refund')).toMatchObject({ deltaDays: 0, deltaCents: 0 });
    expect(r.applyIntent).toEqual({ deliveryTarget: 'home' });                    // "apply this" is derived from the override, not from model words
    expect(t.delivery.id).toBe('company-1');                                       // the query did not touch the task
  });
  it('if the trip moves 2 days earlier (deadline Nov 14): nothing arrives in time; margins are exact', () => {
    const r = quote(t, { deadline: '2026-11-14' });
    expect(row(r, 'exchange')).toMatchObject({ timingAlt: 'late', marginAltDays: -2 });   // Nov 14 - Nov 16
    expect(row(r, 'repair')).toMatchObject({ timingAlt: 'late', marginAltDays: -6 });
    expect(r.applyIntent).toEqual({ deadline: '2026-11-14' });
  });
  it('"two days earlier" is computed by the application (deadlineShiftDays), not by the model', () => {
    const r = quote(t, { deadlineShiftDays: -2 });
    expect(r.deadline).toBe('2026-11-14');
    expect(r.assumptions).toEqual(['latest receive date Nov 14 (2 days earlier)']);
    expect(row(r, 'exchange').marginAltDays).toBe(-2);
    expect(r.applyIntent).toEqual({ deadline: '2026-11-14' });
    expect(quote(t, { deadlineShiftDays: 3 }).deadline).toBe('2026-11-19');
    expect(runQuery(q('q1', 'quote_plans', { deadlineShiftDays: -9 }), t)).toMatchObject({ error: 'shifted_deadline_2026-11-07_is_not_after_today' });
    expect(runQuery(q('q1', 'quote_plans', { deadlineShiftDays: -2 }), { ...t, deadline: null })).toMatchObject({ error: 'no_current_deadline_to_shift' });
  });
  it('home AND deadline Nov 14: exchange misses by 1 day', () => {
    expect(row(quote(t, { delivery: 'home', deadline: '2026-11-14' }), 'exchange').marginAltDays).toBe(-1);
  });
  it('a later pickup date moves repair and refund, not the exchange', () => {
    const r = quote(t, { pickupDate: '2026-11-13' });
    expect(row(r, 'repair')).toMatchObject({ etaAltDate: '2026-11-22', deltaDays: 2 });   // 13 +1 +5 +3
    expect(row(r, 'exchange').deltaDays).toBe(0);
  });
  it('method store changes the wording of the steps, not the dates', () => {
    const steps = quotePlan('exchange', { orderId: O1, deadline: null, delivery: t.delivery, pickupDate: null, method: 'store' })!.steps.map((s) => s.label);
    expect(steps).toContain('you drop off the old unit');
    expect(steps).not.toContain('old unit picked up');
    expect(quotePlan('repair', { orderId: O1, deadline: null, delivery: t.delivery, pickupDate: null, method: 'store' })!.steps[0].label).toBe('you drop it off');
    expect(quotePlan('repair', { orderId: O1, deadline: null, delivery: t.delivery, pickupDate: null, method: 'courier' })!.steps[0].label).toBe('pickup');
  });
  it('errors are explicit, not guesses', () => {
    expect(runQuery(q('q1', 'quote_plans', { delivery: 'company' }), task('multi_company'))).toMatchObject({ error: 'several_company_addresses:company-1,company-2' });
    expect(runQuery(q('q1', 'quote_plans', { delivery: 'company' }), task('no_company', { delivery: initialTask(scenarioById('no_company')).delivery }))).toMatchObject({ error: 'no_company_address_saved' });
    expect(runQuery(q('q1', 'quote_plans', { pickupDate: '2026-12-25' }), t)).toMatchObject({ error: 'pickup_date_outside_2026-11-11_2026-11-17' });
    expect(runQuery(q('q1', 'quote_plans', {}), { ...t, orderId: null })).toMatchObject({ error: 'no_item_chosen_yet' });
  });
});

describe('tool service_points and policy_terms', () => {
  it('near the company: closest first, schematic km hand-computed (1 unit = 0.5 km)', () => {
    const r = runQuery(q('q1', 'service_points', {}), task()) as PointsResult;
    expect(r.near).toBe('company');
    expect(r.points.map((p) => [p.id, p.distanceKm, p.rank])).toEqual([['sp-2', 2.8, 1], ['sp-1', 8.9, 2], ['sp-3', 22, 3]]);
    expect(r.points.find((p) => p.id === 'sp-3')!.supportsPlan).toBe(false);          // sp-3 handles refunds only; the plan is exchange
    expect(r.points.find((p) => p.id === 'sp-2')).toMatchObject({ appointment: true, hours: '10:00-21:00' });
  });
  it('near home and a subset by id (a two-way comparison)', () => {
    const r = runQuery(q('q1', 'service_points', { near: 'home', ids: ['sp-1', 'sp-2'] }), task()) as PointsResult;
    expect(r.points.map((p) => [p.id, p.distanceKm])).toEqual([['sp-1', 5.7], ['sp-2', 14.1]]);
  });
  it('terms come from policy data', () => {
    const r = runQuery(q('q1', 'policy_terms', { plan: 'refund' }), task());
    expect(r).toMatchObject({ tool: 'policy_terms', terms: [{ plan: 'refund' }] });
  });
});

describe('queries proposed by the model are validated', () => {
  it.each([
    [{ id: 'q1', tool: 'drop_database', args: {} }, 'unknown_tool'],
    [{ id: 'x', tool: 'quote_plans', args: {} }, 'bad_query_id'],
    [{ id: 'q1', tool: 'quote_plans', args: { price: 1 } }, 'unknown_arg:price'],
    [{ id: 'q1', tool: 'quote_plans', args: { deadline: 'next week' } }, 'bad_deadline'],
    [{ id: 'q1', tool: 'quote_plans', args: { method: 'drone' } }, 'bad_method'],
    [{ id: 'q1', tool: 'quote_plans', args: { deadlineShiftDays: 2.5 } }, 'bad_deadlineShiftDays'],
    [{ id: 'q1', tool: 'quote_plans', args: { deadlineShiftDays: 99 } }, 'bad_deadlineShiftDays'],
    [{ id: 'q1', tool: 'quote_plans', args: { deadline: '2026-11-14', deadlineShiftDays: -1 } }, 'deadline_and_shift_together'],
    [{ id: 'q1', tool: 'service_points', args: { ids: ['sp-99'] } }, 'bad_ids'],
  ])('rejects %j', (query, reason) => expect(validateQuery(query, new Set())).toEqual({ ok: false, reason }));
  it('duplicate ids are rejected', () => { const seen = new Set<string>(); expect(validateQuery(q('q1', 'policy_terms'), seen).ok).toBe(true); expect(validateQuery(q('q1', 'policy_terms'), seen).ok).toBe(false); });
});

describe('the fact guard: figures in the wording must come from the application', () => {
  const allowed = buildFacts(task()).allowed;
  it('accepts figures that are in the facts', () => {
    expect(guardAnswer('Exchange arrives Nov 16 for ¥10.00, on your Nov 16 deadline; repair arrives Nov 20. Delivering home would be Nov 15 at ¥0.00, 1 day earlier.', allowed)).toEqual([]);
    expect(guardAnswer('The Central Service Center is 8.9 km away.', allowed)).toEqual([]);
  });
  it('flags an invented amount, date, day count or distance', () => {
    expect(guardAnswer('It will cost ¥99.00.', allowed)).toEqual(['¥99.00']);
    expect(guardAnswer('It arrives on Nov 30.', allowed)).toEqual(['Nov 30']);
    expect(guardAnswer('That is 42 days later.', allowed)).toEqual(['42 days']);
    expect(guardAnswer('It is 31.5 km away.', allowed)).toEqual(['31.5 km']);
    expect(guardAnswer('Pay 77 yuan.', allowed)).toEqual(['77 yuan']);
  });
  it('"margin 0 days" and other words that merely start like a month are not dates (found by the real-model run)', () => {
    expect(guardAnswer('Exchange arrives Nov 16, exactly on your deadline (margin 0 days).', allowed)).toEqual([]);
    expect(guardAnswer('Marching 5 days later is not a date, and neither is Mayhem 9.', allowed).filter((x) => /march|mayhem/i.test(x))).toEqual([]);
    expect(guardAnswer('It arrives on March 9.', allowed)).toEqual(['March 9']);                 // a real month name is still checked
  });
  it('words without figures are never blocked', () => expect(guardAnswer('Exchange is better because it arrives before your deadline.', allowed)).toEqual([]));
});

describe('plan parsing', () => {
  it('accepts a full plan', () => {
    const r = parseTurnPlan({ mode: 'what_if', queries: [q('q1', 'quote_plans', { delivery: 'home' })], answer: 'x', ui: [{ component: 'compare', query: 'q1' }], quick: [{ text: 'Apply', changes: { deliveryTarget: 'home' } }] });
    expect(r.ok && r.plan.ui[0]).toEqual({ component: 'compare', query: 'q1' });
  });
  it.each([
    [{ mode: 'submit' }, 'bad_mode'],
    [{ mode: 'discuss', fee: 1 }, 'unknown_key:fee'],
    [{ mode: 'discuss', ui: [{ component: 'compare', query: 'q9' }] }, 'compare_needs_a_declared_query'],
    [{ mode: 'discuss', ui: [{ component: 'fireworks' }] }, 'unknown_component'],
    [{ mode: 'discuss', ui: [{ component: 'plans' }, { component: 'plans' }, { component: 'plans' }, { component: 'plans' }] }, 'bad_ui'],
    [{ mode: 'change', changes: { orderId: 'RT-FAKE' } }, 'bad_changes:bad_orderId'],
  ])('rejects %j', (raw, reason) => expect(parseTurnPlan(raw)).toEqual({ ok: false, reason }));
  it('an invalid suggested button is dropped and counted; it does not discard a good answer', () => {
    const r = parseTurnPlan({ mode: 'discuss', answer: 'a', quick: [{ text: 'bad', changes: { price: 1 } }, { text: 'good', changes: { deliveryTarget: 'home' } }, { text: '', changes: {} }] });
    expect(r.ok && r.plan.quick).toEqual([{ text: 'good', changes: { deliveryTarget: 'home' } }]);
    expect(r.ok && r.plan.droppedQuick).toBe(2);
  });
  it('equivalent spellings are normalised (saved address id, case, synonyms) but state-changing keys stay strict', () => {
    const t = task();
    const ok = parseTurnPlan({ mode: 'change', changes: { deliveryTarget: 'home-1', locationPref: 'Office' } }, t);
    expect(ok.ok && ok.plan.changes).toEqual({ deliveryTarget: 'home', locationPref: 'company' });
    expect(parseTurnPlan({ mode: 'change', changes: { deliveryTarget: 'my aunt' } }, t)).toEqual({ ok: false, reason: 'bad_changes:bad_deliveryTarget' });
  });
  it('symptom spellings are normalised to the known ids; unknown ones still fail', () => {
    const ok = parseTurnPlan({ mode: 'change', changes: { symptoms: ['One side silent', 'left_side_no_sound', "won't power on", 'charging problem'] } }, task());
    expect(ok.ok && ok.plan.changes.symptoms).toEqual(['one_side_silent', 'no_power', 'charging']);
    expect(parseTurnPlan({ mode: 'change', changes: { symptoms: ['smells like toast'] } }, task())).toEqual({ ok: false, reason: 'bad_changes:bad_symptoms' });
  });
  it('discuss and what_if drop any state changes the model sent', () => {
    for (const mode of ['discuss', 'what_if']) {
      const r = parseTurnPlan({ mode, changes: { deliveryTarget: 'home' }, answer: 'a' });
      expect(r.ok && r.plan.changes).toEqual({}); expect(r.ok && r.plan.ignoredChanges).toBe(true);
    }
    const c = parseTurnPlan({ mode: 'change', changes: { deliveryTarget: 'home' } });
    expect(c.ok && c.plan.changes).toEqual({ deliveryTarget: 'home' });
  });
});

// ---------- whole turns with a scripted model ----------
const script = (plan: unknown, compose?: unknown): { call: ModelCall; stages: Stage[]; prompts: string[] } => {
  const stages: Stage[] = [], prompts: string[] = [];
  return { stages, prompts, call: async (stage, _system, user) => { stages.push(stage); prompts.push(user); return JSON.stringify(stage === 'plan' ? plan : compose); } };
};
const input = (t: TaskState, message: string, history: { role: 'user' | 'agent'; text: string; memo?: string }[] = []) => ({ message, history, task: t });
const snap = (t: TaskState) => JSON.stringify(t);

describe('a turn: discuss, what-if, change', () => {
  it('discuss: a direct answer from the facts; nothing changes; one model call', async () => {
    const t = task(); const before = snap(t);
    const s = script({ mode: 'discuss', answer: 'Exchange arrives Nov 16, right on your deadline, for ¥10.00. Repair would arrive Nov 20, 4 days late.' });
    const r = await runTurn(input(t, 'Why is exchange better for my trip than repair?'), s.call);
    expect(r.kind).toBe('turn');
    if (r.kind !== 'turn') return;
    expect(r.guard).toEqual({ ok: true, violations: [], replaced: false });
    expect(r.plan.answer).toContain('Nov 20');
    expect(s.stages).toEqual(['plan']);
    expect(snap(t)).toBe(before);
    expect(s.prompts[0]).toContain('"plansWithCurrentSettings"');                                    // the model really received the facts and the state
    expect(s.prompts[0]).toContain('Why is exchange better');
  });
  it('an answer with a figure the application did not compute is replaced by a facts-only answer', async () => {
    const s = script({ mode: 'discuss', answer: 'Repair would arrive Nov 25 and costs ¥99.00.' });
    const r = await runTurn(input(task(), 'repair?'), s.call);
    if (r.kind !== 'turn') throw new Error(r.reason);
    expect(r.guard.ok).toBe(false); expect(r.guard.replaced).toBe(true); expect(r.guard.violations).toEqual(['¥99.00', 'Nov 25']);
    expect(r.plan.answer).toContain('Exchange: estimated delivery Nov 16, cost ¥10.00');
    expect(r.plan.answer).toContain('Repair: estimated delivery Nov 20, cost ¥0.00');
    expect(r.plan.answer).not.toContain('¥99');
  });
  it('an empty answer to a question is replaced too (never "ask away")', async () => {
    const r = await runTurn(input(task(), 'why?'), script({ mode: 'discuss', answer: '' }).call);
    if (r.kind !== 'turn') throw new Error(r.reason);
    expect(r.guard.replaced).toBe(true); expect(r.plan.answer).toContain('Exchange');
  });
  it('what_if with a tool: two calls, results shown as a compare card, state untouched, memo for later adoption', async () => {
    const t = task(); const before = snap(t);
    const s = script({ mode: 'what_if', changes: { deliveryTarget: 'home' }, queries: [q('q1', 'quote_plans', { delivery: 'home' })], answer: '' },
      { answer: 'Delivering to your home would bring the exchange to Nov 15, 1 day earlier, and ¥0.00 instead of ¥10.00. Nothing was changed.', ui: [] });
    const r = await runTurn(input(t, 'If I ship it home instead, how much sooner? Do not change the address yet.'), s.call);
    if (r.kind !== 'turn') throw new Error(r.reason);
    expect(s.stages).toEqual(['plan', 'compose']);
    expect(s.prompts[1]).toContain('QUERY RESULTS');
    expect(r.ignoredChanges).toBe(true); expect(r.plan.changes).toEqual({});                      // the model tried to change the address in a what-if: discarded
    expect(r.plan.ui).toEqual([{ component: 'compare', query: 'q1' }]);                            // added by the application as evidence
    expect(r.guard.ok).toBe(true);
    expect(r.memo).toContain('delivery to Home');
    expect(r.memo).toContain('{"deliveryTarget":"home"}');
    expect(snap(t)).toBe(before);
  });
  it('the second call can only use figures from the query results', async () => {
    const s = script({ mode: 'what_if', queries: [q('q1', 'quote_plans', { deadline: '2026-11-14' })] }, { answer: 'Exchange arrives Nov 16, 2 days late, so it will not make Nov 14.' });
    const r = await runTurn(input(task(), 'My trip is two days earlier. Can I still make it?'), s.call);
    if (r.kind !== 'turn') throw new Error(r.reason);
    expect(r.guard.ok).toBe(true);                                                                 // Nov 16 and 2 days (margin -2) are in the results
    const bad = await runTurn(input(task(), 'My trip is two days earlier. Can I still make it?'), script({ mode: 'what_if', queries: [q('q1', 'quote_plans', { deadline: '2026-11-14' })] }, { answer: 'Exchange would arrive Nov 13.' }).call);
    if (bad.kind !== 'turn') throw new Error(bad.reason);
    expect(bad.guard.replaced).toBe(true);
    expect(bad.plan.answer).toContain('latest receive date Nov 14');
    expect(bad.plan.answer).toContain('misses your deadline by 2 days');
  });
  it('change: goes through the deterministic path; only what was named changes; diff says so', async () => {
    const t = task('standard', { pickup: { method: 'courier', date: '2026-11-12', slot: '09:00-12:00', servicePointId: null } });
    const memo = memoOf([quote(t, { delivery: 'home' })]);
    const s = script({ mode: 'change', changes: { deliveryTarget: 'home' }, answer: '' });
    const r = await runTurn(input(t, 'Use the home address we just compared, keep everything else.', [{ role: 'agent', text: 'Delivering home would be sooner.', memo }]), s.call);
    if (r.kind !== 'turn') throw new Error(r.reason);
    expect(r.plan.mode).toBe('change'); expect(r.plan.changes).toEqual({ deliveryTarget: 'home' }); expect(r.guard.replaced).toBe(false);
    const after = applyIntent(t, r.plan.changes).task;
    const d = diffTask(t, after);
    expect(d.changed).toEqual([{ label: 'Delivery address', from: 'Company · Example Tower', to: 'Home' }]);
    expect(d.kept).toEqual(expect.arrayContaining(['Item', 'Plan', 'Return method', 'Pickup / drop-off date', 'Time slot', 'Latest receive date']));
    expect(after.pickup).toEqual(t.pickup); expect(after.planId).toBe('exchange'); expect(after.deadline).toBe('2026-11-16');
  });
  it('failures are explicit: model error, not JSON, invalid plan - never a silent substitute', async () => {
    expect(await runTurn(input(task(), 'x'), async () => { throw new Error('http_503'); })).toMatchObject({ kind: 'failed', reason: 'model_error: http_503' });
    expect(await runTurn(input(task(), 'x'), async () => 'nope')).toMatchObject({ kind: 'failed', reason: 'model_output_not_json' });
    expect(await runTurn(input(task(), 'x'), script({ mode: 'discuss', answer: 'a', fee: 1 }).call)).toMatchObject({ kind: 'failed', reason: 'invalid_turn_plan:unknown_key:fee' });
    expect(await runTurn(input(task(), 'x'), script({ mode: 'what_if', queries: [{ id: 'q1', tool: 'shell', args: {} }] }).call)).toMatchObject({ kind: 'failed', reason: 'invalid_turn_plan:unknown_tool' });
  });
  it('a failed query is shown as an explicit limitation', async () => {
    const r = await runTurn(input(task('multi_company'), 'What if it goes to the company?'), script({ mode: 'what_if', queries: [q('q1', 'quote_plans', { delivery: 'company' })] }, { answer: 'I could not evaluate that.' }).call);
    if (r.kind !== 'turn') throw new Error(r.reason);
    expect(r.results[0]).toMatchObject({ error: 'several_company_addresses:company-1,company-2' });
    expect(r.plan.ui).toEqual([]);                                                                  // nothing to compare, no empty card
  });
});

describe('what the model is told about what the user is looking at', () => {
  it('lists the orders shown, with positions and ids, while the agent waits for the order', () => {
    const t = { ...initialTask(scenarioById('standard')), orderHint: 'headphones' as const };
    const f = JSON.parse(buildFacts(t).text);
    expect(f.PENDING.agentIsWaitingFor).toBe('order');
    expect(f.PENDING.ordersShownToUser).toEqual([{ position: 1, id: 'RT-20260620-1001', name: 'Aurora Pro Wireless ANC Headphones', inWarranty: true }, { position: 2, id: 'RT-20250418-0733', name: 'Aurora Lite Bluetooth Headphones', inWarranty: false }]);
  });
  it('lists service points in the order shown (closest first, only those that handle the plan) while waiting for one', () => {
    const f = JSON.parse(buildFacts({ ...task(), pickup: { method: 'store', date: null, slot: null, servicePointId: null }, locationPref: 'company' }).text);
    expect(f.PENDING.agentIsWaitingFor).toBe('servicepoint');
    expect(f.PENDING.servicePointsShownToUser.map((x: { id: string }) => x.id)).toEqual(['sp-2', 'sp-1']);
  });
  it('the contract says that giving information or answering the pending question is a change, and forbids "ask away"', async () => {
    const s = script({ mode: 'discuss', answer: 'x' });
    await runTurn(input(task(), 'hi'), s.call);
    expect(s.prompts[0]).toContain('"PENDING"');
    const { turnSystemPrompt } = await import('../src/retail/turn.ts');
    expect(turnSystemPrompt()).toContain('GIVES information or ANSWERS');
    expect(turnSystemPrompt()).toContain('Never reply with "ask away"');
    expect(turnSystemPrompt()).toContain('NEVER ask the user for missing information yourself');
    expect(turnSystemPrompt()).toContain('"no_power"|"one_side_silent"');
  });
});

describe('fallback renderer and untrusted input', () => {
  it('renders facts generically for any set of results', () => {
    const t = task();
    const text = fallbackAnswer(t, [quote(t, { delivery: 'home' })]);
    expect(text).toContain('If delivery to Home (Urban)');
    expect(text).toContain('Exchange: estimated delivery Nov 15 (1 day earlier than now), cost ¥0.00 (¥10.00 less)');
  });
  it('parseTask / parseHistory reject malformed browser input', () => {
    expect(parseTask(JSON.parse(JSON.stringify(task())))).not.toBeNull();
    expect(parseTask({})).toBeNull(); expect(parseTask(null)).toBeNull();
    expect(parseTask({ ...task(), orderId: 'RT-FAKE' })).toBeNull();
    expect(parseTask({ ...task(), book: [{ id: 1 }] })).toBeNull();
    expect(parseTask({ ...task(), submit: { status: 'done' } })!.submit.status).toBe('done');
    expect(parseHistory([{ role: 'user', text: 'hi' }, { role: 'x', text: 'no' }, 'junk'])).toEqual([{ role: 'user', text: 'hi', memo: undefined }]);
  });
});

describe('appointment-only service points', () => {
  const store = (slot: string | null) => setPickup(setPickup(setPlan(task('standard', { delivery: task().book[0] }), 'exchange'), { method: 'store' }), { servicePointId: 'sp-2', date: '2026-11-13', slot });   // method first (switching method clears the slot)
  it('cannot be submitted without a booked slot, and asks for it', () => {
    expect(readiness(store(null)).join()).toContain('needs an appointment');
    expect(nextNeed(store(null))).toBe('dropdate');
    expect(payloadOf(store(null))).toBeNull();
    expect(readiness(store('14:00-18:00'))).toEqual([]);
    expect(nextNeed(store('14:00-18:00'))).toBe('confirm');
  });
  it('a full slot is refused (13th: third slot is full)', () => {
    const t = store('18:00-20:00'); const s = { ...t, pickup: { ...t.pickup, slot: '18:00-20:00' } };
    expect(readiness(s).join()).toContain('is full');
  });
  it('a walk-in point needs no slot', () => {
    const t = setPickup(setPickup(setPlan(task('standard', { delivery: task().book[0] }), 'exchange'), { method: 'store' }), { servicePointId: 'sp-1', date: '2026-11-13' });
    expect(readiness(t)).toEqual([]);
  });
});
