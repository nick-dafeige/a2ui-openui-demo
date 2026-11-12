/**
 * Paid verification of the RETAIL interpreter (one DeepSeek request per case, all reserved first). Each phrase is sent with the
 * same context the app sends, then compared with what the rules fallback would have understood. Saves raw I/O, never the key.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deepseekComplete } from '../src/ai/planner.ts';
import { loadEnv } from '../src/env.ts';
import { scenarioById } from '../src/retail/data.ts';
import { contextFor } from '../src/retail/context.ts';
import { interpretMessage, parseIntentLocal, type Complete, type Intent } from '../src/retail/intent.ts';
import { candidateOrders, initialTask, nextNeed, setPickup, setPlan, type TaskState } from '../src/retail/state.ts';

loadEnv();
if (!process.env.DEEPSEEK_API_KEY) { console.error('verify-retail-live refused: DEEPSEEK_API_KEY is not set.'); process.exit(2); }
const dir = join(process.cwd(), 'evidence/v0.3.0/live', new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z');
mkdirSync(dir, { recursive: true });

const base = (): TaskState => initialTask(scenarioById('standard'));
const O1 = 'RT-20260620-1001', O2 = 'RT-20250418-0733';
const withItem = (): TaskState => ({ ...base(), orderHint: 'headphones', orderId: O1, symptoms: ['one_side_silent'] });
const withDate = (): TaskState => ({ ...withItem(), deadline: '2026-11-16' });
const withPlan = (): TaskState => setPlan(withDate(), 'exchange');
const withStore = (): TaskState => setPickup(withPlan(), { method: 'store' });
const cases: { say: string; t: TaskState; ok: (i: Intent) => boolean; want: string }[] = [
  { say: 'My headphones are broken and I need them for a business trip next week. Please help.', t: base(), want: 'orderHint=headphones, tripNextWeek, NO dates', ok: (i) => i.orderHint === 'headphones' && !!i.tripNextWeek && !i.deadline && !i.departDate },
  { say: 'The first one, the left side has no sound', t: { ...base(), orderHint: 'headphones' }, want: `orderId=${O1}, one_side_silent`, ok: (i) => i.orderId === O1 && !!i.symptoms?.includes('one_side_silent') },
  { say: 'the second one', t: { ...base(), orderHint: 'headphones' }, want: `orderId=${O2}`, ok: (i) => i.orderId === O2 },
  { say: 'Exchange, ship it to my company', t: withDate(), want: 'planChoice=exchange, deliveryTarget=company', ok: (i) => i.planChoice === 'exchange' && i.deliveryTarget === 'company' },
  { say: 'Can I get a refund?', t: withDate(), want: 'NO planChoice (a question is not a choice)', ok: (i) => i.planChoice === undefined },
  { say: 'I would like to drop-off, give me the address', t: withPlan(), want: 'returnMethod=store', ok: (i) => i.returnMethod === 'store' },
  { say: '旧耳机我自己拿去寄，给我地址', t: withPlan(), want: 'returnMethod=store (Chinese)', ok: (i) => i.returnMethod === 'store' },
  { say: 'Near my company', t: withStore(), want: 'locationPref=company', ok: (i) => i.locationPref === 'company' },
  { say: 'the central one', t: { ...withStore(), locationPref: 'company' }, want: 'servicePointId=sp-1', ok: (i) => i.servicePointId === 'sp-1' },
  { say: "I'll bring it in on Nov 13", t: { ...withStore(), locationPref: 'company', pickup: { ...withStore().pickup, servicePointId: 'sp-1' } }, want: 'pickupDate=2026-11-13 (not a deadline)', ok: (i) => i.pickupDate === '2026-11-13' && !i.deadline },
];

let failedModel = 0, failedRules = 0;
const rows: unknown[] = [];
for (const [n, c] of cases.entries()) {
  const raw: { response?: string; error?: string } = {};
  const inner = deepseekComplete({ reserveStage: `retail-live-verify:${n + 1}` });
  const rec: Complete = async (s, u) => { try { return (raw.response = await inner(s, u)); } catch (e) { raw.error = (e as Error).message; throw e; } };
  const need = nextNeed(c.t);
  const out = await interpretMessage(c.say, rec, contextFor(c.t));
  const rules = parseIntentLocal(c.say, { orders: candidateOrders(c.t), expect: need === 'order' ? 'order' : need === 'servicepoint' || need === 'location' ? 'servicepoint' : need === 'deadline' ? 'deadline' : need === 'dropdate' || need === 'pickup' ? 'pickupdate' : undefined });
  const modelPass = out.kind === 'intent' && c.ok(out.intent);
  const rulesPass = c.ok(rules);
  if (!modelPass) failedModel++; if (!rulesPass) failedRules++;
  rows.push({ say: c.say, need, wanted: c.want, rawModelResponse: raw, modelOutcome: out, rulesIntent: rules, modelPass, rulesPass });
  console.log(`${modelPass ? 'MODEL PASS' : 'MODEL FAIL'} | ${rulesPass ? 'rules pass' : 'rules FAIL'} | ${c.want}  <-  "${c.say}"${raw.error ? ' (' + raw.error + ')' : ''}${out.kind === 'intent' ? '  => ' + JSON.stringify(out.intent) : '  => ' + out.reason}`);
}
writeFileSync(join(dir, 'results.json'), JSON.stringify({ cases: cases.length, failedModel, failedRules, rows }, null, 2) + '\n');
console.log(`model failed ${failedModel}/${cases.length}, rules failed ${failedRules}/${cases.length}; evidence: ${dir}`);
process.exit(failedModel ? 1 : 0);
