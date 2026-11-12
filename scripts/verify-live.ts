/**
 * Paid verification (5 DeepSeek requests per run, all reserved first). Needs DEEPSEEK_API_KEY
 * (environment or .env) and a budget in evidence/MODEL_CALL_BUDGET.json. Saves raw I/O (never the key).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deepseekComplete, planQuestion, type Complete, type PlanOutcome } from '../src/ai/planner.ts';
import { loadEnv } from '../src/env.ts';

loadEnv();
if (!process.env.DEEPSEEK_API_KEY) { console.error('verify:live refused: DEEPSEEK_API_KEY is not set (offline checks: npm run verify:offline).'); process.exit(2); }

const dir = join(process.cwd(), 'evidence/phase2/live', new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z');
mkdirSync(dir, { recursive: true });

const cases: { q: string; expect: (o: PlanOutcome) => boolean; want: string }[] = [
  { q: 'Take a look at how each Campaign did last week', want: 'plan campaign_overview', expect: (o) => o.kind === 'plan' && o.request.intent === 'campaign_overview' },
  { q: "Which Campaign's answer rate dropped the most?", want: 'plan change_analysis', expect: (o) => o.kind === 'plan' && o.request.intent === 'change_analysis' },
  { q: 'Expand Payment Reminder and show me its unanswered calls', want: 'plan unanswered_drilldown c2', expect: (o) => o.kind === 'plan' && o.request.intent === 'unanswered_drilldown' && o.request.campaignIds?.[0] === 'c2' },
  { q: 'Expand this Campaign', want: 'need_campaign', expect: (o) => o.kind === 'need_campaign' },
  { q: 'What was the revenue per call last week?', want: 'unknown_metric', expect: (o) => o.kind === 'unknown_metric' },
];

let failed = 0;
for (const [i, c] of cases.entries()) {
  const raw: { response?: string; error?: string } = {};
  const inner = deepseekComplete({ reserveStage: `live-smoke:${i + 1}` });
  const recording: Complete = async (s, u) => { try { return (raw.response = await inner(s, u)); } catch (e) { raw.error = (e as Error).message; throw e; } };
  const outcome = await planQuestion(c.q, recording);
  const pass = c.expect(outcome);
  if (!pass) failed++;
  writeFileSync(join(dir, `case${i + 1}.json`), JSON.stringify({ question: c.q, wanted: c.want, rawModelResponse: raw, appOutcome: outcome, pass }, null, 2) + '\n');
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.want}  <-  "${c.q}"  => ${outcome.kind}${raw.error ? ' (' + raw.error + ')' : ''}`);
}
writeFileSync(join(dir, 'summary.json'), JSON.stringify({ cases: cases.length, failed, note: 'Live model responses; pass = model chose the expected intent/outcome after app validation.' }, null, 2) + '\n');
console.log(`evidence: ${dir}`);
process.exit(failed ? 1 : 0);
