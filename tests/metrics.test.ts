import { describe, expect, it } from 'vitest';
import expected from './expected.json' with { type: 'json' };
import { generateCalls } from '../src/data/generate.ts';
import { REFERENCE } from '../src/data/spec.ts';
import { answerRateChange, dailyTrend, drillDown, inRange, perCampaign, previousRange, summarize } from '../src/query/metrics.ts';

const calls = generateCalls();
const range = REFERENCE.lastWeek;
const ids = Object.keys(expected.campaigns);
const close = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-6);

describe('demo data', () => {
  it('uses only fictional phone numbers and fixed reference range', () => {
    expect(calls.every((c) => /^\+1-555-01\d\d$/.test(c.phone))).toBe(true);
    expect(expected.range).toEqual(range);
    expect(previousRange(range)).toEqual(expected.previousRange);
  });
  it('is deterministic', () => expect(generateCalls()).toEqual(calls));
});

describe('overview figures match hand-computed expectations', () => {
  const rows = perCampaign(calls, range, ids);
  it.each(ids)('campaign %s', (id) => {
    const e = (expected.campaigns as any)[id];
    const s = rows.find((r) => r.campaignId === id)!.summary;
    expect(s.calls).toBe(e.calls);
    expect(s.answered).toBe(e.answered);
    expect(s.conversions).toBe(e.conversions);
    expect(close(s.answerRate, e.answerRate)).toBe(true);
    expect(close(s.conversionRate, e.conversionRate)).toBe(true);
  });
  it('totals', () => {
    const t = summarize(calls.filter((r) => inRange(r, range)));
    expect({ calls: t.calls, answered: t.answered, conversions: t.conversions, unanswered: t.unanswered }).toEqual(expected.totals);
  });
  it('conversion rate uses answered as denominator, not calls', () => {
    const s = rows.find((r) => r.campaignId === 'c1')!.summary;
    expect(s.conversionRate).toBeCloseTo(39 / 130);
    expect(s.conversionRate).not.toBeCloseTo(39 / 200);
  });
  it('zero denominator yields null (shown as "—"), not 0', () => {
    expect(rows.find((r) => r.campaignId === 'c7')!.summary.conversionRate).toBeNull();
    expect(rows.find((r) => r.campaignId === 'c5')!.summary.answerRate).toBeNull();
  });
});

describe('change analysis', () => {
  const change = answerRateChange(calls, range, ids);
  it.each(ids)('campaign %s change and previous counts', (id) => {
    const e = (expected.campaigns as any)[id];
    const row = change.find((r) => r.campaignId === id)!;
    expect(close(row.changePp, e.changePp)).toBe(true);
    expect(close(row.previous.answerRate, e.prevAnswerRate)).toBe(true);
    expect(row.previous.calls).toBe(e.prevCalls);
  });
  it('ranks most negative first; incomparable last and never zero', () => {
    expect(change.map((r) => r.campaignId)).toEqual(expected.changeRankingOrder);
    expect(change.find((r) => r.campaignId === 'c4')!.changePp).toBeNull();
  });
});

describe('daily trend', () => {
  it('has one point per day and sums to the total', () => {
    const t = dailyTrend(calls, range);
    expect(t).toHaveLength(7);
    expect(t.reduce((n, p) => n + p.calls, 0)).toBe(expected.totals.calls);
  });
});

describe('drill-down', () => {
  const q = { campaignId: 'c2', range } as const;
  it('lists only unanswered calls of that campaign and range', () => {
    const all = drillDown(calls, { ...q, pageSize: 1000 });
    expect(all.total).toBe(expected.c2Unanswered.total);
    expect(all.rows.every((r) => r.campaignId === 'c2' && inRange(r, range) && r.outcome !== 'connected')).toBe(true);
  });
  it.each(['no_answer', 'busy', 'failed'] as const)('filters by outcome %s', (outcome) => {
    const r = drillDown(calls, { ...q, outcome, pageSize: 1000 });
    expect(r.total).toBe(expected.c2Unanswered[outcome]);
    expect(r.rows.every((x) => x.outcome === outcome)).toBe(true);
  });
  it('sorts by time and pages without overlap', () => {
    const p1 = drillDown(calls, { ...q, sort: 'asc', page: 1, pageSize: 50 });
    const p2 = drillDown(calls, { ...q, sort: 'asc', page: 2, pageSize: 50 });
    const times = [...p1.rows, ...p2.rows].map((r) => r.startedAt);
    expect(times).toEqual([...times].sort());
    expect(new Set([...p1.rows, ...p2.rows].map((r) => r.id)).size).toBe(p1.rows.length + p2.rows.length);
  });
  it('respects a narrower date range (excludes previous-week calls)', () => {
    const r = drillDown(calls, { campaignId: 'c2', range: { start: '2026-11-02', end: '2026-11-03' }, pageSize: 1000 });
    expect(r.rows.every((x) => x.startedAt >= '2026-11-02' && x.startedAt < '2026-11-04')).toBe(true);
  });
});
