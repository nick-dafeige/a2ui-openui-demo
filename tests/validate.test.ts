import { describe, expect, it } from 'vitest';
import { validateRequest } from '../src/query/validate.ts';

describe('model output validation (FR-2, FR-4)', () => {
  it('accepts a whitelisted request', () => {
    expect(validateRequest({ intent: 'change_analysis', metrics: ['answer_rate_change'], campaignIds: ['c2'], range: { start: '2026-11-02', end: '2026-11-08' } }).ok).toBe(true);
  });
  it('rejects unknown metric and lists available ones', () => {
    const v = validateRequest({ intent: 'campaign_overview', metrics: ['revenue'] });
    expect(v).toMatchObject({ ok: false, reason: 'unknown_metric' });
    expect((v as any).availableMetrics).toContain('answer_rate');
  });
  it.each([
    [{ intent: 'delete_all' }, 'unsupported_intent'],
    [{ intent: 'campaign_overview', campaignIds: ['zzz'] }, 'unknown_campaign'],
    [{ intent: 'campaign_overview', components: ['iframe'] }, 'unknown_component'],
    [{ intent: 'campaign_overview', range: { start: '2026-11-09', end: '2026-11-01' } }, 'bad_range'],
    [{ intent: 'campaign_overview', figures: { calls: 999 } }, 'unexpected_field'],
    ['nope', 'not_an_object'],
  ])('rejects %j', (raw, reason) => expect(validateRequest(raw)).toMatchObject({ ok: false, reason }));
  it('accepts ranking and only; rejects malformed or orphaned ones', () => {
    expect(validateRequest({ intent: 'campaign_overview', sortBy: 'answer_rate', order: 'desc', limit: 3, only: false }).ok).toBe(true);
    for (const bad of [{ sortBy: 'revenue' }, { sortBy: 'answer_rate_change' }, { sortBy: 'calls', limit: 0 }, { sortBy: 'calls', limit: 8 }, { sortBy: 'calls', limit: 2.5 }, { sortBy: 'calls', order: 'up' }, { limit: 3 }, { only: 'yes' }])
      expect(validateRequest({ intent: 'campaign_overview', ...bad }).ok).toBe(false);
  });
});
