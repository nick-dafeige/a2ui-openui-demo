import { describe, expect, it } from 'vitest';
import { generateCalls } from '../src/data/generate.ts';
import { CAMPAIGNS } from '../src/data/spec.ts';
import { drillDown, inRange, type OutcomeFilter } from '../src/query/metrics.ts';

/** Success criterion: every drill-down list holds only records matching the chosen date range, campaign and outcome. */
describe('drill-down matches its filters for every combination', () => {
  const calls = generateCalls();
  const ranges = [{ start: '2026-11-02', end: '2026-11-08' }, { start: '2026-11-04', end: '2026-11-05' }, { start: '2026-10-26', end: '2026-11-08' }, { start: '2026-11-08', end: '2026-11-08' }, { start: '2026-09-01', end: '2026-09-02' }];
  const outcomes: (OutcomeFilter | undefined)[] = [undefined, 'no_answer', 'busy', 'failed'];
  for (const c of CAMPAIGNS) for (const range of ranges) for (const outcome of outcomes) {
    it(`${c.id} ${range.start}..${range.end} ${outcome ?? 'all'}`, () => {
      const r = drillDown(calls, { campaignId: c.id, range, outcome, pageSize: 10_000 });
      const truth = calls.filter((x) => x.campaignId === c.id && inRange(x, range) && x.outcome !== 'connected' && (!outcome || x.outcome === outcome));
      expect(r.total).toBe(truth.length);
      expect(r.rows.every((x) => x.campaignId === c.id && inRange(x, range) && x.outcome !== 'connected' && (!outcome || x.outcome === outcome))).toBe(true);
      expect(new Set(r.rows.map((x) => x.id)).size).toBe(r.rows.length);
    });
  }
});
