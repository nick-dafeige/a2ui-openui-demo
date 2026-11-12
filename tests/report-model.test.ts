import { describe, expect, it } from 'vitest';
import expected from './expected.json' with { type: 'json' };
import { generateCalls } from '../src/data/generate.ts';
import { buildReport, defaultFilters, specFor } from '../src/report/model.ts';
import { CANNOT_COMPARE, DASH, pct, pp } from '../src/report/format.ts';

const calls = generateCalls();
describe('buildReport', () => {
  it('totals and ranking equal hand-computed expectations', () => {
    const r = buildReport(calls, specFor('change_analysis'), defaultFilters());
    expect(r.totals.calls).toBe(expected.totals.calls);
    expect(r.change.map((c) => c.campaignId)).toEqual(expected.changeRankingOrder);
    expect(r.previous).toEqual(expected.previousRange);
  });
  it('campaign filter narrows every figure', () => {
    const r = buildReport(calls, specFor('campaign_overview'), { ...defaultFilters(), campaignIds: ['c2'] });
    expect(r.totals.calls).toBe(300);
    expect(r.trend.reduce((n, p) => n + p.calls, 0)).toBe(300);
  });
  it('flags an empty result and keeps the filters', () => {
    const f = { range: { start: '2026-09-01', end: '2026-09-07' }, campaignIds: ['c1'] };
    const r = buildReport(calls, specFor('campaign_overview'), f);
    expect(r.empty).toBe(true);
    expect(r.filters).toEqual(f);
  });
  it('adds follow-up components without duplicating or accepting unknown ones', () => {
    expect(specFor('campaign_overview', ['daily_call_volume', 'daily_trend', 'bogus']).components).toEqual(
      ['calls_card', 'answer_rate_card', 'conversion_card', 'daily_trend', 'campaign_table', 'daily_call_volume']);
  });
  it('drill-down data covers only the chosen campaign', () => {
    const r = buildReport(calls, specFor('unanswered_drilldown', [], 'c2'), defaultFilters());
    expect(r.drill!.total).toBe(expected.c2Unanswered.total);
  });
});
describe('format', () => {
  it('shows dash and Cannot compare for missing values, never zero', () => {
    expect(pct(null)).toBe(DASH);
    expect(pp(null)).toBe(CANNOT_COMPARE);
    expect(pct(0)).toBe('0.0%');
    expect(pp(0)).toBe('0.0 pp');
    expect(pp(15)).toBe('+15.0 pp');
    expect(pp(-20)).toBe('-20.0 pp');
  });
});
