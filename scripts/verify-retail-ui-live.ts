/**
 * v0.5.0 FROZEN live protocol (PAID, small). Runs the model-written-interface turn against the REAL model with wordings that are
 * NOT used in the prompt, including Chinese. Each case records FOUR things separately (they are different claims):
 *   render      - the Lang parsed and passed the application's validation (and how many writes it took)
 *   facts       - figures/bindings are the application's (by construction through the guard + bindings; also checked per case)
 *   interaction - the controls offered are the right ones, and pressing them gives the intended state change
 *   task        - the structure fits what was asked (structural check, not a judgement of usefulness)
 * Run with: npx vite-node scripts/verify-retail-ui-live.ts   (CASES=2,5 reruns a subset). Every request is reserved against the
 * ledger first; failures and repairs count. Raw model output and traces (no key) go to evidence/v0.5.0-<timestamp>/live/.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deepseekComplete, deepseekLang } from '../src/ai/planner.ts';
import { loadEnv } from '../src/env.ts';
import { scenarioById } from '../src/retail/data.ts';
import { applyIntent } from '../src/retail/flow.ts';
import { diffTask, initialTask, setPickup, setPlan, type TaskState } from '../src/retail/state.ts';
import { buildServerTrace, type ModelEvent } from '../src/retail/trace.ts';
import { runUiTurn } from '../src/retail/openui/compose.ts';
import { eventToIntent } from '../src/retail/openui/events.ts';
import { isGood, type HistoryItem, type Stage, type TurnOk } from '../src/retail/turn.ts';

loadEnv();
if (!process.env.DEEPSEEK_API_KEY) { console.error('refused: DEEPSEEK_API_KEY is not set.'); process.exit(2); }
const ledger = JSON.parse(readFileSync(join(process.cwd(), 'evidence/MODEL_CALL_BUDGET.json'), 'utf8')) as { maximum_requests: number; recorded_requests: number };
const only = process.env.CASES?.split(',').map(Number);
const stamp = process.env.RUN_DIR ?? `v0.5.0-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z`;
const dir = join(process.cwd(), 'evidence', stamp, 'live');
mkdirSync(dir, { recursive: true });

const O1 = 'RT-20260620-1001';
const base = (): TaskState => { const t = initialTask(scenarioById('standard')); return { ...t, orderId: O1, symptoms: ['one_side_silent'], deadline: '2026-11-16', delivery: t.book.find((a) => a.kind === 'company')! }; };
const chosen = (): TaskState => setPlan(base(), 'exchange');
const storeNear = (): TaskState => ({ ...setPickup(chosen(), { method: 'store' }), locationPref: 'company' });
const atSp2 = (): TaskState => setPickup(storeNear(), { servicePointId: 'sp-2' });
const dated = (): TaskState => setPickup(atSp2(), { date: '2026-11-12' });
const walkIn = (): TaskState => setPickup(storeNear(), { servicePointId: 'sp-1' });

type Out = TurnOk & { lang: NonNullable<TurnOk['lang']> };
interface Case { n: number; say: string; state: () => TaskState; history?: () => HistoryItem[]; apply?: boolean;
  task: (o: Out, s: TaskState) => [string, boolean][]; interaction?: (o: Out, s: TaskState) => [string, boolean][] }
const comps = (o: Out) => o.lang.components;
const has = (o: Out, c: string) => comps(o).includes(c);
const noChange = (o: Out) => o.plan.mode !== 'change' && Object.keys(o.plan.changes).length === 0;
const texts = (o: Out) => o.lang.summary;
const english = (o: Out) => !/[一-鿿]/.test(o.lang.raw);
const asksPending = (o: Out) => o.lang.controls.some((c) => (c.kind === 'select' && (c.field === 'returnMethod' || c.field === 'plan')) || c.kind === 'date' || c.kind === 'slot' || c.kind === 'form');
const memoHistory = (): HistoryItem[] => [
  { role: 'user', text: 'What if I had it sent to my home instead?' },
  { role: 'agent', text: 'Delivering to your home would arrive Nov 15, one day earlier, and cost ¥10.00 less. Nothing has been changed yet.', memo: '[comparison q1: delivery to Home (Urban) | applying it would be {"deliveryTarget":"home"} | Exchange Nov 15 ¥0.00]' }];

const cases: Case[] = [
  { n: 1, say: "My flight leaves on the 16th and I'm nervous about being without headphones. Why would you steer me towards a swap rather than a fix?", state: chosen,
    task: (o) => [['answers directly (a Text of real length, not "ask away")', texts(o).length > 60 && !/ask away|go ahead and ask/i.test(texts(o))], ['discuss, nothing changed', noChange(o)], ['light: no more than 5 components', comps(o).length <= 5], ['does not also ask the pending question', !asksPending(o)]] },
  { n: 2, say: "Hypothetically, if the parcel went to my flat instead of the office, would that change anything? Leave my details alone for now.", state: chosen,
    task: (o) => [['what-if, nothing changed', o.plan.mode === 'what_if' && noChange(o)], ['a comparison for home delivery is shown', has(o, 'QuoteComparison') && o.results.some((r) => isGood(r) && r.tool === 'quote_plans' && r.assumptions.some((a) => /Home/.test(a)))], ['says nothing was changed', /not (been )?chang|nothing (has been |was )?changed|no change/i.test(texts(o)) || has(o, 'QuoteComparison')], ['does not also ask the pending question', !asksPending(o)]],
    interaction: (o) => [['offers to adopt that comparison', o.lang.controls.some((c) => c.kind === 'adopt')]] },
  { n: 3, say: '如果寄到家里会更快吗？先别改地址。', state: chosen,
    task: (o) => [['what-if, nothing changed', o.plan.mode === 'what_if' && noChange(o)], ['comparison shown', has(o, 'QuoteComparison')], ['interface text is English (UI is English-only)', english(o)], ['does not also ask the pending question', !asksPending(o)]],
    interaction: (o) => [['offers to adopt', o.lang.controls.some((c) => c.kind === 'adopt')]] },
  { n: 4, say: "I'd rather not pay the ¥10 shipping. Is there any other way to go?", state: chosen,
    task: (o) => [['nothing changed', noChange(o)], ['shows alternatives with application evidence (comparison, metrics or a plan choice)', has(o, 'QuoteComparison') || has(o, 'QuoteMetric') || o.lang.controls.some((c) => c.kind === 'select' && c.field === 'plan')], ['mentions a zero-cost route or repair/home', /¥0\.00|free|no (extra )?(cost|charge)|repair|home/i.test(texts(o))], ['does not also ask the pending question (a plan choice is a legitimate answer to "other ways")', !o.lang.controls.some((c) => c.kind === 'select' && c.field === 'returnMethod')]] },
  { n: 5, say: 'The trip moved two days earlier. Does any of this still work?', state: chosen,
    task: (o) => [['evaluated the Nov 14 deadline with the application tool', o.results.some((r) => isGood(r) && r.tool === 'quote_plans' && r.deadline === '2026-11-14')], ['nothing changed', noChange(o)], ['comparison shown', has(o, 'QuoteComparison')], ['does not claim it all works', !/everything (still )?works|all (plans )?(still )?(work|arrive in time)/i.test(texts(o))], ['does not also ask the pending question', !asksPending(o)]] },
  { n: 6, say: 'Which is closer to me, the central service center or the new district store, and can I book a time at either?', state: storeNear,
    task: (o) => [['nothing changed', noChange(o)], ['shows both service points (summaries or a map with a choice)', (comps(o).filter((c) => c === 'ServicePointSummary').length >= 2) || (has(o, 'Map') && o.lang.controls.some((c) => c.kind === 'select' && c.field === 'servicePoint'))], ['says which needs an appointment', /appointment/i.test(texts(o)) || has(o, 'ServicePointSummary') || has(o, 'Map')]] },
  { n: 7, say: 'OK, use the home address we just compared and leave the rest as it is.', state: chosen, history: memoHistory, apply: true,
    task: (o, s) => { const after = applyIntent(s, o.plan.changes, { noAsk: true }).task; const d = diffTask(s, after); return [['a change', o.plan.mode === 'change'], ['only the delivery address changed', d.changed.length === 1 && d.changed[0].label === 'Delivery address' && /Home/.test(d.changed[0].to)], ['plan, deadline, item untouched', after.planId === 'exchange' && after.deadline === '2026-11-16' && after.orderId === O1]]; },
    interaction: (o) => [['asks the next thing only (return method)', o.lang.need === 'method' && o.lang.controls.some((c) => c.kind === 'select' && c.field === 'returnMethod')]] },
  { n: 8, say: "I'll come on the 13th, between 2 and 6 in the afternoon.", state: atSp2, apply: true,
    task: (o, s) => { const after = applyIntent(s, o.plan.changes, { noAsk: true }).task; return [['a change', o.plan.mode === 'change'], ['date AND slot captured from one sentence', after.pickup.date === '2026-11-13' && after.pickup.slot === '14:00-18:00'], ['nothing else touched', after.planId === 'exchange' && after.pickup.servicePointId === 'sp-2']]; },
    interaction: (o) => [['no input asked (everything known; the application shows the summary)', o.lang.need === 'confirm' && !o.lang.controls.some((c) => c.kind === 'date' || c.kind === 'slot' || c.kind === 'form')]] },
  { n: 9, say: '我13号下午两点到六点过去。', state: atSp2, apply: true,
    task: (o, s) => { const after = applyIntent(s, o.plan.changes, { noAsk: true }).task; return [['a change', o.plan.mode === 'change'], ['date and slot captured from Chinese', after.pickup.date === '2026-11-13' && after.pickup.slot === '14:00-18:00'], ['interface text is English', english(o)]]; },
    interaction: (o) => [['no input asked', o.lang.need === 'confirm' && !o.lang.controls.some((c) => c.kind === 'date' || c.kind === 'slot' || c.kind === 'form')]] },
  { n: 10, say: '为什么这种情况推荐换货，而不是维修？', state: chosen,
    task: (o) => [['answers directly', texts(o).length > 60], ['discuss, nothing changed', noChange(o)], ['interface text is English', english(o)], ['does not also ask the pending question', !asksPending(o)]] },
  { n: 11, say: 'Okay, that store works. What do you need from me now?', state: dated, apply: true,
    task: (o) => [['asks only for the time window (no date picker: the date is known)', has(o, 'TimeSlotPicker') && !has(o, 'DatePicker')]],
    interaction: (o) => [['a slot control is offered', o.lang.controls.some((c) => c.kind === 'slot' || (c.kind === 'form' && c.fields.includes('pickupSlot')))]] },
  { n: 12, say: "Alright, I'll drop it in myself.", state: walkIn, apply: true,
    task: (o) => [['asks only for the day (walk-in point: no time window)', has(o, 'DatePicker') && !has(o, 'TimeSlotPicker')]],
    interaction: (o) => [['a date control is offered', o.lang.controls.some((c) => c.kind === 'date' || (c.kind === 'form' && c.fields.includes('pickupDate')))]] },
];

const needed = (only ? cases.filter((c) => only.includes(c.n)) : cases).length * 2;
const remaining = ledger.maximum_requests - ledger.recorded_requests;
if (remaining < needed + 6) { console.error(`refused: ledger has ${remaining} requests left, this run may need ~${needed} (+repairs).`); process.exit(3); }
console.log(`ledger ${ledger.recorded_requests}/${ledger.maximum_requests}; running ${needed / 2} case(s) (about ${needed} requests plus repairs) -> ${dir}`);

const summary: { n: number; say: string; render: boolean; attempts: number; repaired: boolean; checks: [string, boolean, string][]; requests: number }[] = [];
for (const c of cases) {
  if (only && !only.includes(c.n)) continue;
  const state = c.state(); const calls: { stage: Stage; events: ModelEvent[] }[] = [];
  const t0 = Date.now();
  const out = await runUiTurn({ message: c.say, history: c.history?.() ?? [], task: state }, async (stage, system, user) => {
    const entry = { stage, events: [] as ModelEvent[] }; calls.push(entry);
    const make = stage === 'lang' || stage === 'repair' ? deepseekLang : deepseekComplete;
    return make({ reserveStage: `v0.5.0-live:${c.n}:${stage}`, trace: (e) => entry.events.push(e), timeoutMs: 60_000 })(system, user);
  });
  const trace = buildServerTrace({ requestId: `rq-live-${c.n}`, at: new Date().toISOString(), mode: 'live', messageChars: c.say.length, contextChars: 0, calls, outcome: out.kind === 'turn' ? out : { kind: 'failed', reason: out.reason }, model: 'deepseek-chat', totalMs: Date.now() - t0 });
  const checks: [string, boolean, string][] = [];
  const add = (dim: string, list: [string, boolean][]) => list.forEach(([name, ok]) => checks.push([name, ok, dim]));
  let render = false;
  if (out.kind !== 'turn' || !out.lang) { add('render', [[`turn produced (${out.kind === 'failed' ? out.reason : 'no lang'})`, false]]); }
  else {
    render = out.lang.ok;
    add('render', [['Lang validated by the application', out.lang.ok], ['no more than one repair', out.lang.attempts <= 2]]);
    add('facts', [['every figure in wording is in the facts (guard inside validation)', out.lang.ok || out.lang.errors.every((e) => !/figure_not_in_facts/.test(e)) ], ['all references are bindings of the right kind (validated)', out.lang.ok || out.lang.errors.every((e) => !/binding|ref must/.test(e))]]);
    if (out.lang.ok) {
      const o = out as Out;
      add('task', c.task(o, state));
      if (c.interaction) add('interaction', c.interaction(o, state));
      // pressing every offered select/adopt control must be accepted by the application's event check
      const accepted = o.lang.controls.filter((x) => x.kind === 'adopt' || x.kind === 'select').every((x) => x.kind === 'adopt' ? eventToIntent({ kind: 'adopt', ref: x.ref }, o.lang.controls, o.lang.bundle).ok : eventToIntent({ kind: 'select', field: x.field, ref: x.refs[0] }, o.lang.controls, o.lang.bundle).ok || x.field === 'delivery');
      add('interaction', [['offered controls are all accepted by the application event check', accepted]]);
    }
  }
  const reqs = trace.calls.filter((x) => x.modelCalled).length;
  summary.push({ n: c.n, say: c.say, render, attempts: out.kind === 'turn' ? out.lang?.attempts ?? 0 : 0, repaired: out.kind === 'turn' ? !!out.lang?.repaired : false, checks, requests: reqs });
  writeFileSync(join(dir, `case-${String(c.n).padStart(2, '0')}.json`), JSON.stringify({ case: c.n, say: c.say, state: c.state(), history: c.history?.() ?? [], outcome: out.kind === 'turn' ? { mode: out.plan.mode, changes: out.plan.changes, queries: out.results, lang: out.lang, report: out.report, notes: out.notes } : out, trace, checks }, null, 1));
  console.log(`#${c.n} render=${render} req=${reqs}${out.kind === 'turn' && out.lang?.repaired ? ' (repaired)' : ''}  ${checks.map(([n, ok, d]) => `${ok ? '✓' : '✗'}${d[0]}:${n}`).join(' | ')}`);
}
const dim = (d: string) => { const l = summary.flatMap((s) => s.checks.filter((x) => x[2] === d)); return `${l.filter((x) => x[1]).length}/${l.length}`; };
const totalReq = summary.reduce((a, s) => a + s.requests, 0);
writeFileSync(join(dir, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), requestsThisRun: totalReq, byDimension: { render: dim('render'), facts: dim('facts'), interaction: dim('interaction'), task: dim('task') }, cases: summary.map((s) => ({ n: s.n, render: s.render, attempts: s.attempts, failed: s.checks.filter((x) => !x[1]).map((x) => `${x[2]}:${x[0]}`) })) }, null, 1));
console.log(`\nrequests this run: ${totalReq}; render ${dim('render')}, facts ${dim('facts')}, interaction ${dim('interaction')}, task ${dim('task')}`);
