/**
 * PAID, deliberately small (1-2 DeepSeek requests per case, every request reserved against the ledger first). Runs the turn
 * planner against the REAL model with differently worded questions and checks STRUCTURED outcomes: facts in the answer, state
 * not mutated by discussion / what-if, components chosen, adoption changing exactly one field. Needs DEEPSEEK_API_KEY and budget.
 * CASES=1,4 reruns a subset. Saves raw model responses (no key) to evidence/v0.4.0/live/<time>/.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deepseekComplete } from '../src/ai/planner.ts';
import { loadEnv } from '../src/env.ts';
import { scenarioById } from '../src/retail/data.ts';
import { applyIntent } from '../src/retail/flow.ts';
import { diffTask, initialTask, setPickup, setPlan, type TaskState } from '../src/retail/state.ts';
import { buildServerTrace, type ModelEvent } from '../src/retail/trace.ts';
import { isGood, runTurn, type GoodResult, type HistoryItem, type TurnOk, type Stage } from '../src/retail/turn.ts';

loadEnv();
if (!process.env.DEEPSEEK_API_KEY) { console.error('refused: DEEPSEEK_API_KEY is not set.'); process.exit(2); }
const ledger = JSON.parse(readFileSync(join(process.cwd(), 'evidence/MODEL_CALL_BUDGET.json'), 'utf8')) as { maximum_requests: number; recorded_requests: number };
const remaining = ledger.maximum_requests - ledger.recorded_requests;
const only = process.env.CASES?.split(',').map(Number);
const dir = join(process.cwd(), 'evidence/v0.4.0/live', new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z');
mkdirSync(dir, { recursive: true });

const O1 = 'RT-20260620-1001';
const base = (): TaskState => { const t = initialTask(scenarioById('standard')); return { ...t, orderId: O1, symptoms: ['one_side_silent'], deadline: '2026-11-16', delivery: t.book.find((a) => a.kind === 'company')! }; };
const chosen = (): TaskState => setPlan(base(), 'exchange');
const courier = (): TaskState => setPickup(chosen(), { method: 'courier', date: '2026-11-12', slot: '09:00-12:00' });
const storeMode = (): TaskState => ({ ...setPickup(chosen(), { method: 'store' }), locationPref: 'company' });

interface Case { n: number; say: string; state: () => TaskState; history?: () => HistoryItem[]; check: (r: TurnOk, state: TaskState) => [string, boolean][] }
const text = (r: TurnOk) => r.plan.answer;
const has = (r: TurnOk, re: RegExp) => re.test(text(r));
const res = (r: TurnOk, tool: GoodResult['tool']): GoodResult[] => r.results.filter(isGood).filter((x) => x.tool === tool);
let c2memo = '', c2answer = '';
const cases: Case[] = [
  { n: 1, say: 'Why is exchange better for my trip than repair?', state: base, check: (r) => [
    ['answers (not "ask away")', text(r).length > 40 && !/ask away|go ahead and ask/i.test(text(r))],
    ['cites exchange date Nov 16 (company delivery)', has(r, /Nov 16/)], ['cites repair date Nov 20', has(r, /Nov 20/)],
    ['says repair is late / misses', has(r, /late|miss|after|too long|not in time|won.t (make|arrive)/i)],
    ['no state change requested', Object.keys(r.plan.changes).length === 0], ['guard ok (no invented figure)', r.guard.ok]] },
  { n: 2, say: "What if I have it delivered to my house instead? Don't change the address yet.", state: chosen, check: (r) => [
    ['no state change requested', Object.keys(r.plan.changes).length === 0 && r.plan.mode !== 'change'],
    ['states the home date Nov 15', has(r, /Nov 15/)], ['says sooner / earlier / faster / one day', has(r, /earlier|sooner|faster|quicker|1 day|one day|a day/i)],
    ['shows evidence (compare card)', r.plan.ui.some((u) => u.component === 'compare')], ['guard ok', r.guard.ok]] },
  { n: 3, say: "I don't want to pay the 10 yuan. What other options do I have?", state: chosen, check: (r) => [
    ['mentions a zero-cost route (¥0.00 / free)', has(r, /¥0\.00|free|no (extra )?(cost|charge|fee)/i)],
    ['names repair or home delivery as the alternatives', has(r, /repair/i) || has(r, /home|house/i)],
    ['is honest that repair is late or home is cheaper-and-earlier', has(r, /Nov 19|Nov 20|late|miss|earlier|Nov 15/i)],
    ['no state change', Object.keys(r.plan.changes).length === 0 && r.plan.mode !== 'change'], ['guard ok', r.guard.ok]] },
  { n: 4, say: 'My trip got moved up two days. Can I still make it?', state: chosen, check: (r) => [
    ['evaluated Nov 14 with a tool (or cites it)', res(r, 'quote_plans').some((x) => x.tool === 'quote_plans' && x.deadline === '2026-11-14') || has(r, /Nov 14/)],
    ['does not claim it works', !has(r, /yes[,.! ]|will (make|arrive) in time|still (make|arrive)/i) || has(r, /not|miss|won.t|cannot|no plan|late/i)],
    ['says it misses / not in time', has(r, /not|miss|won.t|cannot|no (plan|option)|late/i)],
    ['no state change', Object.keys(r.plan.changes).length === 0 && r.plan.mode !== 'change'], ['guard ok', r.guard.ok]] },
  { n: 5, say: "Compare the two service points for me, but don't submit anything.", state: storeMode, check: (r) => [
    ['service_points evidence includes both sp-1 and sp-2', res(r, 'service_points').some((x) => x.tool === 'service_points' && ['sp-1', 'sp-2'].every((id) => x.points.some((p) => p.id === id)))],
    ['compare component shown', r.plan.ui.some((u) => u.component === 'compare' || u.component === 'servicepoints')],
    ['mentions appointment or hours', has(r, /appointment|walk-in|open|hours|\d\d:\d\d/i)],
    ['no state change / nothing submitted', Object.keys(r.plan.changes).length === 0 && r.plan.mode !== 'change'], ['guard ok', r.guard.ok]] },
  { n: 6, say: 'Use the home address we just compared, and keep everything else as it is.', state: courier,
    history: () => [{ role: 'user', text: "What if I have it delivered to my house instead? Don't change the address yet." }, { role: 'agent', text: c2answer || 'Delivering to your home would bring the exchange to Nov 15, 1 day earlier.', memo: c2memo || '[comparison q1: delivery to Home (Urban) | applying it would be {"deliveryTarget":"home"} | Exchange Nov 15 ¥0.00]' }],
    check: (r, s) => { const after = applyIntent(s, r.plan.changes).task; const d = diffTask(s, after); return [
      ['mode is change', r.plan.mode === 'change'], ['changes are exactly deliveryTarget=home', JSON.stringify(r.plan.changes) === '{"deliveryTarget":"home"}'],
      ['only the delivery address changed', d.changed.length === 1 && d.changed[0].label === 'Delivery address'],
      ['plan, return method, date and slot kept', after.planId === 'exchange' && JSON.stringify(after.pickup) === JSON.stringify(s.pickup) && after.deadline === s.deadline]]; } },
];
const fresh = (): TaskState => initialTask(scenarioById('standard'));
cases.push(
  { n: 7, say: 'My headphones are broken and I need them for a business trip next week. Please help.', state: fresh, check: (r, s) => { const after = applyIntent(s, r.plan.changes).task; return [
    ['treated as information (change), not a question', r.plan.mode === 'change'], ['recorded the product kind', after.orderHint === 'headphones'], ['no invented dates', !after.deadline && !after.departDate], ['no wording about "ask away"', !/ask away/i.test(text(r))]]; } },
  { n: 8, say: 'The first one, the left side has no sound', state: () => ({ ...fresh(), orderHint: 'headphones' }), check: (r, s) => { const after = applyIntent(s, r.plan.changes).task; return [
    ['change', r.plan.mode === 'change'], ['picked order 1 (Aurora Pro)', after.orderId === O1], ['recorded the symptom', after.symptoms.includes('one_side_silent')]]; } },
);
// second wording of each question kind, checked by the SAME structural checks (not by matching the sentence)
const variant = (n: number, of: number, say: string) => { const o = cases.find((c) => c.n === of)!; cases.push({ ...o, n, say }); };
variant(9, 1, 'Which one is the safer pick for my business trip, exchange or repair, and why?');
variant(10, 2, 'How much faster would the exchange be if it went to my home address? Just checking, keep the current address.');
variant(11, 3, 'Is there anything cheaper than paying the ¥10 shipping?');
variant(12, 4, 'If I have to leave 2 days sooner, will the replacement still get here in time?');
variant(13, 5, "Which is better for me, the store that needs an appointment or the Central one? Don't book anything.");
variant(14, 6, 'Okay, go with the home address from that comparison. Nothing else should change.');
const todo = cases.filter((c) => !only || only.includes(c.n));
if (remaining < todo.length * 2 + 3) { console.error(`refused: ledger has ${remaining} requests left; this run may need up to ${todo.length * 2} and a margin of 3 is kept.`); process.exit(3); }

let failed = 0;
const rows: unknown[] = [];
for (const c of todo) {
  const state = c.state();
  const calls: { stage: Stage; events: ModelEvent[]; raw?: string; error?: string }[] = [];
  const t0 = Date.now();
  const out = await runTurn({ message: c.say, history: c.history?.() ?? [], task: state }, async (stage, system, user) => {
    const e = { stage, events: [] as ModelEvent[], raw: undefined as string | undefined, error: undefined as string | undefined }; calls.push(e);
    try { return (e.raw = await deepseekComplete({ reserveStage: `retail-turns-verify:${c.n}:${stage}`, trace: (x) => e.events.push(x), timeoutMs: 45_000 })(system, user)); } catch (err) { e.error = (err as Error).message; throw err; }
  });
  const trace = buildServerTrace({ requestId: `rq-verify-${c.n}`, at: new Date().toISOString(), mode: 'live', messageChars: c.say.length, contextChars: 0, calls, outcome: out.kind === 'turn' ? out : { kind: 'failed', reason: out.reason }, model: 'deepseek-chat', totalMs: Date.now() - t0 });
  if (out.kind === 'failed') { failed++; rows.push({ n: c.n, say: c.say, failed: out.reason, rawModelResponses: calls.map((x) => ({ stage: x.stage, raw: x.raw, error: x.error })), trace }); console.log(`FAIL #${c.n} "${c.say}" -> ${out.reason}`); continue; }
  if (c.n === 2) { c2memo = out.memo; c2answer = out.plan.answer; }
  const checks = c.check(out, state);
  const bad = checks.filter(([, ok]) => !ok);
  if (bad.length) failed++;
  rows.push({ n: c.n, say: c.say, mode: out.plan.mode, answer: out.plan.answer, changes: out.plan.changes, ui: out.plan.ui, quick: out.plan.quick, tools: out.results.map((r) => r.tool), guard: out.guard, ignoredChanges: out.ignoredChanges, checks: Object.fromEntries(checks), rawModelResponses: calls.map((x) => ({ stage: x.stage, raw: x.raw, error: x.error })), trace });
  console.log(`${bad.length ? 'FAIL' : 'PASS'} #${c.n} [${out.plan.mode}, ${trace.calls.length} call(s), ${trace.totalMs} ms${out.guard.replaced ? ', WORDING REPLACED' : ''}] "${c.say}"\n    answer: ${out.plan.answer.replace(/\n/g, ' ').slice(0, 260)}\n    tools: ${out.results.map((r) => r.tool).join('+') || '-'} ui: ${out.plan.ui.map((u) => u.component).join('+') || '-'}${bad.length ? `\n    FAILED CHECKS: ${bad.map(([k]) => k).join('; ')}` : ''}`);
}
writeFileSync(join(dir, 'results.json'), JSON.stringify({ at: new Date().toISOString(), cases: todo.length, failed, ledgerBefore: ledger.recorded_requests, rows }, null, 2) + '\n');
console.log(`failed ${failed}/${todo.length}; evidence: ${dir}`);
process.exit(failed ? 1 : 0);
