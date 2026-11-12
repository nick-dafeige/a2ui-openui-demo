/** Offline (no model calls): merges the v0.5.0 live runs into one table (latest run of each case wins, earlier ones are kept and listed), and writes the library spec, the Lang system prompt and the state diff of every case that changed state. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyIntent } from '../src/retail/flow.ts';
import { diffTask, type TaskState } from '../src/retail/state.ts';
import { LIBRARY_VERSION, library } from '../src/retail/openui/library.tsx';
import { langSystemPrompt } from '../src/retail/openui/compose.ts';

const root = join(process.cwd(), 'evidence');
const runs = (process.env.RUNS ?? 'v0.5.0-20261111-live1,v0.5.0-20261111-live2,v0.5.0-20261111-live3,v0.5.0-20261111-live4').split(',');
const out = join(root, process.env.OUT ?? 'v0.5.0-20261111'); mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'library-spec.json'), JSON.stringify({ version: LIBRARY_VERSION, components: library.toSpec() }, null, 1));
writeFileSync(join(out, 'lang-system-prompt.txt'), langSystemPrompt());

interface CaseFile { case: number; say: string; state: TaskState; outcome: { mode?: string; changes?: Record<string, unknown>; lang?: { ok: boolean; attempts: number; repaired: boolean; components: string[]; errors: string[]; need: string | null; controls: unknown[]; bundle: { stateRevision: string } }; kind?: string; reason?: string }; trace: { calls: { stage: string; modelMs: number | null }[]; totalMs: number }; checks: [string, boolean, string][] }
const latest = new Map<number, { run: string; c: CaseFile }>(); const history: Record<number, string[]> = {};
for (const run of runs) {
  const d = join(root, run, 'live'); if (!existsSync(d)) continue;
  for (const f of readdirSync(d).filter((x) => /^case-\d+\.json$/.test(x))) {
    const c = JSON.parse(readFileSync(join(d, f), 'utf8')) as CaseFile;
    (history[c.case] ??= []).push(`${run}: ${c.outcome.lang ? (c.outcome.lang.ok ? 'validated' : 'rejected') : 'no lang'}`);
    latest.set(c.case, { run, c });
  }
}
const rows = [...latest.entries()].sort((a, b) => a[0] - b[0]).map(([n, { run, c }]) => {
  const l = c.outcome.lang; let diff: unknown = null;
  if (c.outcome.mode === 'change' && c.outcome.changes) { const after = applyIntent(c.state, c.outcome.changes as never, { noAsk: true }).task; diff = diffTask(c.state, after).changed; }
  const dims = (d: string) => { const l2 = c.checks.filter((x) => x[2] === d); return l2.length ? `${l2.filter((x) => x[1]).length}/${l2.length}` : '-'; };
  return { n, say: c.say, run, mode: c.outcome.mode ?? c.outcome.kind, components: l?.components.join('+') ?? '', validated: l?.ok ?? false, writes: l?.attempts ?? 0, need: l?.need ?? null, stateChanges: diff, calls: c.trace.calls.map((x) => `${x.stage} ${x.modelMs ?? '?'}ms`).join(', '), render: dims('render'), facts: dims('facts'), interaction: dims('interaction'), task: dims('task'), failedChecks: c.checks.filter((x) => !x[1]).map((x) => `${x[2]}:${x[0]}`), earlierRuns: history[n].slice(0, -1) };
});
writeFileSync(join(out, 'live-cases.json'), JSON.stringify(rows, null, 1));
const md = ['| # | wording | mode | components | validated (writes) | state change | render | facts | interaction | task | earlier runs |', '|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.n} | ${r.say.replace(/\|/g, '/').slice(0, 70)} | ${r.mode} | ${r.components} | ${r.validated ? 'yes' : 'NO'} (${r.writes}) | ${r.stateChanges ? JSON.stringify(r.stateChanges).replace(/\|/g, '/') : 'none'} | ${r.render} | ${r.facts} | ${r.interaction} | ${r.task} | ${r.earlierRuns.join('; ') || '-'} |`)].join('\n');
writeFileSync(join(out, 'live-cases.md'), md + '\n');
console.log(md);
