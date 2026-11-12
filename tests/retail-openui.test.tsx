/**
 * v0.5.0 model-written interface: bindings, validation, events, orchestration (scripted model: proves wiring and the safety
 * checks, NOT model quality) and rendering with the real OpenUI Renderer. Expected values are hand-derived from data.ts/rules.ts
 * (company -> home delivery: exchange Nov 16 -> Nov 15, 1 day earlier, 10.00 cheaper; sp-2 is 14.1 km from home, 2.8 km from company).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { scenarioById, type ScenarioId } from '../src/retail/data.ts';
import { initialTask, nextNeed, revisionOf, setPickup, setPlan, type TaskState } from '../src/retail/state.ts';
import { buildAllowed, buildFacts, runQuery, type ModelCall, type QueryResult, type QuoteResult, type Stage } from '../src/retail/turn.ts';
import { bindingCatalog, buildBundle } from '../src/retail/openui/bundle.ts';
import { runUiEvent, runUiTurn, langSystemPrompt } from '../src/retail/openui/compose.ts';
import { eventToIntent, type Control } from '../src/retail/openui/events.ts';
import { checkLang, stripFences } from '../src/retail/openui/validate.ts';
import { COMPONENT_NAMES, EnvContext, LIBRARY_VERSION, library } from '../src/retail/openui/library.tsx';
import { Renderer } from '@openuidev/react-lang';

const O1 = 'RT-20260620-1001';
function task(scn: ScenarioId = 'standard', o: Partial<TaskState> = {}): TaskState {
  const t = initialTask(scenarioById(scn));
  const company = t.book.find((a) => a.kind === 'company') ?? t.delivery;
  return { ...t, orderId: O1, symptoms: ['one_side_silent'], deadline: '2026-11-16', delivery: company, planId: 'exchange', ...o };
}
const homeQuery = (t: TaskState) => runQuery({ id: 'q1', tool: 'quote_plans', args: { delivery: 'home' } }, t) as QuoteResult;
function ctx(t: TaskState, results: QueryResult[] = [], message = 'x', requireNeed = false) {
  const facts = buildFacts(t);
  return { bundle: buildBundle(t, results, 'task'), state: t, need: nextNeed(t), requireNeed, allowed: buildAllowed({ message, history: [] }, facts.text, results) };
}
const GOOD = `root = Stack([t, cmp, q])
t = Text("Delivering to your home would arrive on Nov 15 instead of Nov 16 and cost ¥10.00 less. Nothing has been changed yet.")
cmp = QuoteComparison("cmp.q1")
q = QuickReply("Use the home address", "adopt", "cmp.q1")`;

describe('library and prompt', () => {
  it('has the layout, content and input components of the proposal', () => {
    for (const n of ['Stack', 'Section', 'Columns', 'Text', 'Notice', 'OrderSummary', 'WarrantyStatus', 'QuoteMetric', 'QuoteComparison', 'AddressSummary', 'ServicePointSummary', 'Map', 'SingleChoice', 'MultiChoice', 'QuickReply', 'Form', 'DatePicker', 'TimeSlotPicker']) expect(COMPONENT_NAMES).toContain(n);
    expect(LIBRARY_VERSION).toContain('@openuidev/react-lang 1.1.0');
  });
  it('the system prompt is generated from the library spec and carries the application rules, with no JSON demand', () => {
    const p = langSystemPrompt();
    expect(p).toContain('QuoteComparison(ref: string)');
    expect(p).toContain('THE APPLICATION OWNS THE FACTS');
    expect(p).not.toMatch(/Query\(|Mutation\(|@Run/);       // tools/bindings sections are switched off: the application runs tools, not the program
  });
});

describe('EvidenceBundle', () => {
  const t = task(); const r = homeQuery(t); const b = buildBundle(t, [r], 'task');
  it('what-if rows are bound with application-formatted values', () => {
    const alt = b.bindings['quote.q1.alt.exchange'];
    expect(alt).toMatchObject({ kind: 'quote', quote: { eta: 'Nov 15', total: '¥0.00', change: '1 day earlier · ¥10.00 less', timing: 'arrives in time, 1 day before your deadline' } });
    expect(b.bindings['quote.now.exchange']).toMatchObject({ quote: { eta: 'Nov 16', total: '¥10.00', timing: 'arrives on your deadline day' } });   // Nov 16 vs deadline Nov 16: never "before"
    expect(b.bindings['cmp.q1']).toMatchObject({ kind: 'compare', applyIntent: { deliveryTarget: 'home' } });
  });
  it('service points carry distance from where the search is anchored (home when no preference: 14.1 km for sp-2)', () => {
    expect(b.bindings['sp.sp-2']).toMatchObject({ kind: 'sp', distanceKm: 14.1, appointment: true });
    const near = buildBundle({ ...t, locationPref: 'company' }, [], 'task');
    expect(near.bindings['sp.sp-2']).toMatchObject({ distanceKm: 2.8 });
  });
  it('is stamped with the state revision, which changes when the state changes', () => {
    expect(b.stateRevision).toBe(revisionOf(t));
    expect(revisionOf(setPlan(t, 'repair'))).not.toBe(revisionOf(t));
    expect(revisionOf({ ...t, preference: 'cheapest' })).not.toBe(revisionOf(t));
  });
  it('catalog lists only usable ids', () => {
    const c = bindingCatalog(b, t);
    expect(c).toContain('cmp.q1 = what-if comparison');
    expect(c).toContain('sp.sp-2 = service point');
    expect(bindingCatalog(buildBundle(task('no_company'), [], 'task'), task('no_company'))).not.toContain('loc.company');
  });
});

describe('checkLang: the application rejects what the renderer would silently drop or accept', () => {
  const t = task(); const r = homeQuery(t); const c = ctx(t, [r]);
  const bad = (prog: string, c2 = c) => checkLang(prog, c2);
  it('accepts a grounded what-if answer and records its controls', () => {
    const v = bad(GOOD);
    expect(v.errors).toEqual([]); expect(v.ok).toBe(true);
    expect(v.controls).toEqual([{ kind: 'adopt', ref: 'cmp.q1' }]);
    expect(v.components).toEqual(['Stack', 'Text', 'QuoteComparison', 'QuickReply']);
  });
  it('strips a code fence', () => { expect(stripFences('```openui\nroot = Stack([a])\na = Text("x")\n```')).toBe('root = Stack([a])\na = Text("x")'); });
  it('rejects a component outside the library', () => {
    expect(bad('root = Stack([a])\na = Carousel("x")').errors.join()).toContain('unknown_component:Carousel');
  });
  it('words inside a string are not constructors: "Home (Urban)" or "$10" in a Text is fine (found in the first live run: false rejections)', () => {
    const v = bad('root = Stack([a, b])\na = Text("Delivering to Home (Urban) would arrive on Nov 15; the Store (demo) opens at 10.")\nb = Text("It would cost ¥10.00 less (Nov 16 now).")');
    expect(v.errors).toEqual([]);
  });
  it('a real unknown constructor next to such words is still rejected', () => {
    expect(bad('root = Stack([a])\na = Carousel("Home (Urban)")').errors.join()).toContain('unknown_component:Carousel');
  });
  it('rejects a binding that does not exist, or has the wrong kind for the component', () => {
    expect(bad('root = Stack([a])\na = QuoteComparison("cmp.q9")').errors.join()).toContain('unknown binding "cmp.q9"');
    expect(bad('root = Stack([a])\na = QuoteComparison("sp.sp-1")').errors.join()).toContain('must be a binding starting with "cmp."');
    expect(bad('root = Stack([a])\na = ServicePointSummary("addr.home-1")').errors.join()).toContain('"sp."');
    expect(bad('root = Stack([a])\na = AddressSummary("order.RT-20260620-1001")').errors.join()).toContain('"addr."');
  });
  it('rejects a figure the application did not compute', () => {
    expect(bad('root = Stack([a])\na = Text("The exchange would cost ¥77.00 in total.")').errors.join()).toContain('figure_not_in_facts: ¥77.00');
    expect(bad('root = Stack([a])\na = Text("It will arrive on Nov 22.")').errors.join()).toContain('Nov 22');
    expect(bad('root = Stack([a])\na = Text("It is 99 km away.")').errors.join()).toContain('99 km');
  });
  it('rejects unreferenced statements (the renderer would drop them silently) and unresolved references', () => {
    expect(bad('root = Stack([a])\na = Text("x")\nb = Text("lost")').errors.join()).toContain('unreferenced_statement:b');
    expect(bad('root = Stack([a, ghost])\na = Text("x")').errors.join()).toContain('unresolved_reference:ghost');
  });
  it('rejects illegal actions: bad apply values, adopting something that is not a comparison, Query/Mutation/@actions', () => {
    expect(bad('root = Stack([a])\na = QuickReply("Go", "apply", "deliveryTarget", "mars")').errors.join()).toContain('not a legal value');
    expect(bad('root = Stack([a])\na = QuickReply("Go", "apply", "submit", "yes")').errors.join()).toContain('target must be one of');
    expect(bad('root = Stack([a])\na = QuickReply("Go", "adopt", "sp.sp-1")').errors.join()).toContain('QuickReply(adopt)');
    expect(bad('root = Stack([a])\na = Text("x")\nq = Mutation("submit_case", {})').errors.join()).toContain('unsupported_feature');
    expect(bad('root = Stack([a])\na = Text("x")\n$v = 1').errors.join()).toContain('unsupported_feature');
  });
  it('metric "change" exists only on what-if quotes', () => {
    expect(bad('root = Stack([a])\na = QuoteMetric("quote.now.exchange", "change")').errors.join()).toContain('only exists on a what-if');
    expect(bad('root = Stack([a])\na = QuoteMetric("quote.q1.alt.exchange", "change")').ok).toBe(true);
  });
  it('enforces structure limits', () => {
    const many = `root = Stack([${Array.from({ length: 9 }, (_, i) => `t${i}`).join(', ')}])\n${Array.from({ length: 9 }, (_, i) => `t${i} = Text("x")`).join('\n')}`;
    expect(bad(many).errors.join()).toContain('Stack.children: 9 item(s), allowed 1-8');
  });
  it('a choice needs bindings of the right kind for its field', () => {
    expect(bad('root = Stack([a])\na = SingleChoice("servicePoint", ["plan.exchange"])').errors.join()).toContain('"sp."');
    expect(bad('root = Stack([a])\na = SingleChoice("returnMethod", ["method.courier", "loc.home"])').errors.join()).toContain('"method."');
    expect(bad('root = Stack([a, b])\na = SingleChoice("plan", ["plan.exchange"])\nb = SingleChoice("plan", ["plan.repair"])').errors.join()).toContain('duplicate_control');
  });
});

describe('checkLang: the program must offer what the application is waiting for', () => {
  const afterPlan = setPlan(task('standard', { pickup: { method: 'store', date: null, slot: null, servicePointId: null } }), 'exchange');
  it('servicepoint need: a Map alone is not enough; a SingleChoice(servicePoint) is', () => {
    expect(nextNeed({ ...afterPlan, locationPref: 'company' })).toBe('servicepoint');
    const t = { ...afterPlan, locationPref: 'company' as const };
    expect(checkLang('root = Stack([a, m])\na = Text("Here are the nearby points.")\nm = Map(["sp.sp-1", "sp.sp-2"])', ctx(t, [], 'x', true)).errors.join()).toContain('missing_input');
    const ok = checkLang('root = Stack([m, c])\nm = Map(["sp.sp-1", "sp.sp-2"])\nc = SingleChoice("servicePoint", ["sp.sp-1", "sp.sp-2"], "Pick one")', ctx(t, [], 'x', true));
    expect(ok.errors).toEqual([]);
    expect(ok.controls).toContainEqual({ kind: 'select', field: 'servicePoint', refs: ['sp.sp-1', 'sp.sp-2'] });
  });
  const booking = setPickup(setPlan(task(), 'exchange'), { method: 'store', servicePointId: 'sp-2' });
  it('dropdate at an appointment-only point with nothing booked: needs a date AND a slot (a Form does both)', () => {
    expect(nextNeed(booking)).toBe('dropdate');
    expect(checkLang('root = Stack([d])\nd = DatePicker("pickupDate")', ctx(booking, [], 'x', true)).errors.join()).toContain('TimeSlotPicker');
    const form = checkLang('root = Stack([f])\nf = Form("Book your visit", [d, s], "Book")\nd = DatePicker("pickupDate")\ns = TimeSlotPicker()', ctx(booking, [], 'x', true));
    expect(form.errors).toEqual([]);
    expect(form.controls).toEqual([{ kind: 'form', fields: ['pickupDate', 'pickupSlot'] }]);
  });
  it('only the slot is missing: the date is not asked again (only what is missing appears)', () => {
    const dated = setPickup(booking, { date: '2026-11-12' });
    expect(nextNeed(dated)).toBe('dropdate');
    expect(checkLang('root = Stack([s])\ns = TimeSlotPicker()', ctx(dated, [], 'x', true)).errors).toEqual([]);
    expect(checkLang('root = Stack([d])\nd = DatePicker("pickupDate")', ctx(dated, [], 'x', true)).errors.join()).toContain('TimeSlotPicker');
  });
  it('confirm need: no input is demanded (the application shows its own confirmation)', () => {
    const ready = setPickup(booking, { date: '2026-11-12', slot: '14:00-18:00' });
    expect(nextNeed(ready)).toBe('confirm');
    expect(checkLang('root = Stack([a])\na = Text("Everything is ready; the summary is next.")', ctx(ready, [], 'x', true)).errors).toEqual([]);
  });
});

describe('eventToIntent: language and components end in the same Intent, and only offered controls work', () => {
  const t = task(); const b = buildBundle(t, [homeQuery(t)], 'task');
  const controls: Control[] = [{ kind: 'select', field: 'servicePoint', refs: ['sp.sp-1', 'sp.sp-2'] }, { kind: 'adopt', ref: 'cmp.q1' }, { kind: 'form', fields: ['pickupDate', 'pickupSlot'] }, { kind: 'apply', field: 'planChoice', value: 'repair' }, { kind: 'ask', text: 'Why exchange?' }];
  it('select / adopt / form / apply / ask', () => {
    expect(eventToIntent({ kind: 'select', field: 'servicePoint', ref: 'sp.sp-2' }, controls, b)).toMatchObject({ ok: true, intent: { servicePointId: 'sp-2' } });
    expect(eventToIntent({ kind: 'adopt', ref: 'cmp.q1' }, controls, b)).toMatchObject({ ok: true, intent: { deliveryTarget: 'home' } });
    expect(eventToIntent({ kind: 'form', values: { pickupDate: '2026-11-13', pickupSlot: '14:00-18:00' } }, controls, b)).toMatchObject({ ok: true, intent: { pickupDate: '2026-11-13', pickupSlot: '14:00-18:00' } });
    expect(eventToIntent({ kind: 'apply', field: 'planChoice', value: 'repair' }, controls, b)).toMatchObject({ ok: true, intent: { planChoice: 'repair' } });
    expect(eventToIntent({ kind: 'ask', text: 'Why exchange?' }, controls, b)).toMatchObject({ ok: true });
  });
  it('refuses controls the message never offered, values outside the offered set, incomplete forms and illegal values', () => {
    expect(eventToIntent({ kind: 'select', field: 'servicePoint', ref: 'sp.sp-3' }, controls, b)).toEqual({ ok: false, reason: 'control_not_offered' });
    expect(eventToIntent({ kind: 'select', field: 'plan', ref: 'plan.refund' }, controls, b)).toEqual({ ok: false, reason: 'control_not_offered' });
    expect(eventToIntent({ kind: 'apply', field: 'planChoice', value: 'refund' }, controls, b)).toEqual({ ok: false, reason: 'control_not_offered' });
    expect(eventToIntent({ kind: 'form', values: { pickupDate: '2026-11-13' } }, controls, b)).toEqual({ ok: false, reason: 'form_incomplete' });
    expect(eventToIntent({ kind: 'form', values: { pickupDate: '2026-11-13', pickupSlot: '13:00-14:00' } }, controls, b)).toMatchObject({ ok: false });
    expect(eventToIntent({ kind: 'adopt', ref: 'cmp.q2' }, controls, b)).toEqual({ ok: false, reason: 'control_not_offered' });
    expect(eventToIntent({ kind: 'ask', text: 'something else' }, controls, b)).toEqual({ ok: false, reason: 'control_not_offered' });
  });
});

// ---------------- orchestration with a scripted model ----------------
const planJson = (o: unknown) => JSON.stringify(o);
function scripted(replies: { plan?: string; lang?: string[]; failAt?: Stage }): { call: ModelCall; stages: Stage[] } {
  const stages: Stage[] = []; let li = 0;
  return { stages, call: async (stage) => {
    stages.push(stage);
    if (replies.failAt === stage) throw new Error('boom');
    if (stage === 'plan') return replies.plan ?? '{}';
    return (replies.lang ?? [])[li++] ?? '';
  } };
}
describe('runUiTurn (scripted model: wiring and safety only)', () => {
  const t = task();
  const whatIf = planJson({ mode: 'what_if', queries: [{ id: 'q1', tool: 'quote_plans', args: { delivery: 'home' } }] });
  it('what-if: two calls (plan, lang), a validated program, and the task is untouched', async () => {
    const before = JSON.stringify(t);
    const m = scripted({ plan: whatIf, lang: [GOOD] });
    const o = await runUiTurn({ message: 'what if I had it sent home?', history: [], task: t }, m.call);
    expect(o.kind).toBe('turn'); if (o.kind !== 'turn') return;
    expect(m.stages).toEqual(['plan', 'lang']);
    expect(o.plan.mode).toBe('what_if'); expect(o.plan.changes).toEqual({});
    expect(o.lang).toMatchObject({ ok: true, repaired: false, attempts: 1, stateRevision: revisionOf(t) });
    expect(o.lang!.controls).toEqual([{ kind: 'adopt', ref: 'cmp.q1' }]);
    expect(JSON.stringify(t)).toBe(before);
  });
  it('an invalid first program gets exactly one repair, counted as a second Lang call', async () => {
    const m = scripted({ plan: whatIf, lang: ['root = Stack([a])\na = Text("It costs ¥77.00.")', GOOD] });
    const o = await runUiTurn({ message: 'x', history: [], task: t }, m.call);
    if (o.kind !== 'turn') throw new Error('expected a turn');
    expect(m.stages).toEqual(['plan', 'lang', 'repair']);
    expect(o.lang).toMatchObject({ ok: true, repaired: true, attempts: 2 });
  });
  it('still invalid after the repair: no third call, the program is NOT usable, and the reasons are kept', async () => {
    const m = scripted({ plan: whatIf, lang: ['root = Stack([a])\na = Carousel("x")', 'root = Stack([a])\na = Text("¥77.00")'] });
    const o = await runUiTurn({ message: 'x', history: [], task: t }, m.call);
    if (o.kind !== 'turn') throw new Error('expected a turn');
    expect(m.stages).toEqual(['plan', 'lang', 'repair']);
    expect(o.lang!.ok).toBe(false); expect(o.lang!.program).toBeNull(); expect(o.lang!.controls).toEqual([]);
    expect(o.lang!.errors.join()).toMatch(/attempt1: unknown_component:Carousel/); expect(o.lang!.errors.join()).toMatch(/attempt2: .*figure_not_in_facts/);
    expect(o.plan.answer).toContain('Nov 15');                         // the application's own wording of the same facts
  });
  it('a model failure is a failure: nothing is invented', async () => {
    const o = await runUiTurn({ message: 'x', history: [], task: t }, scripted({ plan: whatIf, failAt: 'lang' }).call);
    expect(o).toMatchObject({ kind: 'failed' }); expect((o as { reason: string }).reason).toContain('model_error(lang)');
    const o2 = await runUiTurn({ message: 'x', history: [], task: t }, scripted({ failAt: 'plan' }).call);
    expect(o2).toMatchObject({ kind: 'failed' });
  });
  it('a change turn is shown the state AFTER the change and must offer the input for what is missing next', async () => {
    const t0 = task('standard', { planId: null, delivery: task().book[0] });   // home, no plan yet
    const change = planJson({ mode: 'change', changes: { planChoice: 'exchange' } });
    const noInput = scripted({ plan: change, lang: ['root = Stack([a])\na = Text("Exchange selected.")', 'root = Stack([a])\na = Text("Exchange selected.")'] });
    const o = await runUiTurn({ message: 'exchange please', history: [], task: t0 }, noInput.call);
    if (o.kind !== 'turn') throw new Error('turn');
    expect(o.report).toContain('Plan: not set → exchange');
    expect(o.lang!.ok).toBe(false); expect(o.lang!.errors.join()).toContain('missing_input: the application is waiting for method');
    const good = scripted({ plan: change, lang: ['root = Stack([a, c])\na = Text("How should the old unit come back to us?")\nc = SingleChoice("returnMethod", ["method.courier", "method.store"], "Return method")'] });
    const o2 = await runUiTurn({ message: 'exchange please', history: [], task: t0 }, good.call);
    if (o2.kind !== 'turn') throw new Error('turn');
    expect(o2.lang).toMatchObject({ ok: true, need: 'method' });
    expect(good.stages).toEqual(['plan', 'lang']);
  });
  it('discuss with no query still costs exactly two calls and no change', async () => {
    const m = scripted({ plan: planJson({ mode: 'discuss' }), lang: ['root = Stack([a])\na = Text("Exchange suits a trip because the replacement ships first.")'] });
    const o = await runUiTurn({ message: 'why exchange?', history: [], task: t }, m.call);
    if (o.kind !== 'turn') throw new Error('turn');
    expect(m.stages).toEqual(['plan', 'lang']); expect(o.plan.changes).toEqual({}); expect(o.lang!.summary).toContain('replacement ships first');
  });
});
describe('runUiEvent: after a pressed control only the interface call is made', () => {
  it('one Lang call, mode change, and what the application applied is passed through', async () => {
    const t = setPickup(setPlan(task(), 'exchange'), { method: 'store' });
    const m = scripted({ lang: ['root = Stack([a, c])\na = Text("Which service point suits you?")\nc = SingleChoice("servicePoint", ["sp.sp-1", "sp.sp-2"], "Service points")'] });
    const o = await runUiEvent({ message: 'The user chose: I drop it off at a service point', history: [], task: { ...t, locationPref: 'company' }, report: 'Changed: Return method: not set → you drop it off.', notes: '' }, m.call);
    if (o.kind !== 'turn') throw new Error('turn');
    expect(m.stages).toEqual(['lang']); expect(o.lang).toMatchObject({ ok: true, need: 'servicepoint' }); expect(o.report).toContain('Return method');
  });
});

describe('rendering with the real OpenUI Renderer (frozen facts, controls only while live)', () => {
  const t = task(); const r = homeQuery(t); const bundle = buildBundle(t, [r], 'task');
  const html = (program: string, live: boolean) => renderToStaticMarkup(
    <EnvContext.Provider value={{ bundle, state: t, live, emit: () => {}, draft: {}, setDraft: () => {} }}><Renderer response={program} library={library} /></EnvContext.Provider>);
  it('shows application figures from bindings, never model figures', () => {
    const h = html(GOOD + '\nm = QuoteMetric("quote.q1.alt.exchange", "total")', true);
    expect(h).toContain('What-if only · nothing was changed');
    expect(h).toContain('Nov 15'); expect(h).toContain('¥10.00 less');
    const m = html('root = Stack([m])\nm = QuoteMetric("quote.q1.alt.exchange", "total")', true);
    expect(m).toContain('¥0.00'); expect(m).toContain('Exchange · Total cost');
  });
  it('controls are disabled when the message is no longer live; text and facts stay', () => {
    const live = html(GOOD, true), stale = html(GOOD, false);
    expect(live).toMatch(/data-testid="ou-quick"[^>]*>Use the home address/); expect(live).not.toMatch(/ou-quick[^>]*disabled/);
    expect(stale).toMatch(/disabled=""[^>]*data-testid="ou-quick"|data-testid="ou-quick"[^>]*disabled=""/);
    expect(stale).toContain('Nov 15');
  });
  it('a time-slot picker lists only slots inside the opening hours of the chosen point (sp-2: 10:00-21:00)', () => {
    const s = { ...setPickup(setPlan(task(), 'exchange'), { method: 'store', servicePointId: 'sp-2', date: '2026-11-12' }) };
    const h = renderToStaticMarkup(<EnvContext.Provider value={{ bundle, state: s, live: true, emit: () => {}, draft: {}, setDraft: () => {} }}><Renderer response={'root = Stack([a])\na = TimeSlotPicker()'} library={library} /></EnvContext.Provider>);
    expect(h).not.toContain('09:00-12:00'); expect(h).toContain('14:00-18:00'); expect(h).toContain('18:00-20:00');
  });
});

describe('real-map embed (visual only)', () => {
  it('geoOf keeps the 0.5 km-per-unit scale: sp-2 (64,36) vs sp-1 (52,48) are about 8.9 km apart on the ground as in the rule', async () => {
    const { geoOf, embedUrl } = await import('../src/retail/MapView.tsx');
    const a = geoOf({ x: 52, y: 48 }), b = geoOf({ x: 64, y: 36 });
    const km = Math.hypot((b.lat - a.lat) * 111, (b.lng - a.lng) * 111 * Math.cos((30.59 * Math.PI) / 180));
    expect(km).toBeGreaterThan(7.5); expect(km).toBeLessThan(9.5);   // rule: hypot(12,12) * 0.5 = 8.5 km; lng scale differs by <10%
    expect(embedUrl({ x: 50, y: 50 })).toBe('https://maps.google.com/maps?q=30.5928,114.3055&z=14&output=embed');
  });
});
