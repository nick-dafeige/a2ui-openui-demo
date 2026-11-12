import { describe, expect, it } from 'vitest';
import expected from './expected.json' with { type: 'json' };
import { generateCalls } from '../src/data/generate.ts';
import { defaultLayout } from '../src/layout/defaults.ts';
import { drillReport, latestReport, patchReport, reportFromRequest, selectedCampaign, type Msg } from '../src/chat/state.ts';
import { basis, narrative } from '../src/chat/narrative.ts';
import { buildReport } from '../src/report/model.ts';

const L = defaultLayout();
const calls = generateCalls();
const agent = (report: ReturnType<typeof reportFromRequest>): Msg => ({ id: report.id, role: 'agent', text: '', report });

describe('three-turn conversation keeps history', () => {
  const r1 = reportFromRequest({ intent: 'campaign_overview', range: { start: '2026-11-02', end: '2026-11-08' } }, 'live', undefined, L);
  const r2 = reportFromRequest({ intent: 'change_analysis' }, 'live', r1, L);
  const r3 = drillReport(r2, 'c2', L);
  const msgs: Msg[] = [agent(r1), agent(r2), agent(r3)];

  it('each report has its own id, scope and source', () => {
    expect(new Set([r1.id, r2.id, r3.id]).size).toBe(3);
    expect(r3.source).toBe('action');
    expect(r3.filters.range).toEqual(expected.range); // drill inherits the source report's frozen range
  });
  it('a later query never mutates earlier reports', () => {
    const snap = JSON.stringify([r1, r2]);
    reportFromRequest({ intent: 'campaign_overview', range: { start: '2026-10-26', end: '2026-11-01' }, campaignIds: ['c1'] }, 'live', r3, L);
    expect(JSON.stringify([r1, r2])).toBe(snap);
  });
  it('patching one report leaves the other messages untouched (same objects)', () => {
    const out = patchReport(msgs, r3.id, (r) => ({ ...r, openCallId: 'x' }));
    expect(out[0]).toBe(msgs[0]); expect(out[1]).toBe(msgs[1]);
    expect(out[2]).not.toBe(msgs[2]);
    expect(latestReport(out)!.openCallId).toBe('x');
  });
  it('"this campaign" resolves to the latest drilled report', () => expect(selectedCampaign(msgs)).toBe('c2'));
  it('a component-only follow-up extends the previous report in a NEW report, with a layout copy', () => {
    const r = reportFromRequest({ intent: 'campaign_overview', components: ['daily_call_volume'] }, 'live', r1, L);
    expect(r.spec.components).toContain('campaign_table'); expect(r.spec.components).toContain('daily_call_volume');
    expect(r.id).not.toBe(r1.id); expect(r1.spec.components).not.toContain('daily_call_volume');
  });
});

describe('narrative uses engine figures only', () => {
  it('change analysis concludes on a campaign with enough calls and explains the bigger low-sample drop', () => {
    const r = reportFromRequest({ intent: 'change_analysis' }, 'fallback', undefined, L);
    const t = narrative(calls, buildReport(calls, r.spec, r.filters));
    expect(t).toContain('Payment Reminder dropped the most'); expect(t).toContain('60.0% → 40.0% (-20.0 pp)');
    expect(t).toContain('Tiny Sample Test fell more (-50.0 pp)'); expect(t).toContain('not used as the conclusion');
  });
  it('overview totals', () => {
    const r = reportFromRequest({ intent: 'campaign_overview' }, 'fallback', undefined, L);
    expect(narrative(calls, buildReport(calls, r.spec, r.filters))).toContain('720 calls, 48.3% answered');
  });
  it('drill-down outcome counts equal hand-computed values', () => {
    const r = drillReport(reportFromRequest({ intent: 'campaign_overview' }, 'fallback', undefined, L), 'c2', L);
    const t = narrative(calls, buildReport(calls, r.spec, r.filters)); const e = expected.c2Unanswered;
    expect(t).toContain(`${e.total} unanswered calls`); expect(t).toContain(`${e.no_answer} no answer, ${e.busy} busy, ${e.failed} failed`);
  });
  it('states the metric basis', () => {
    const r = reportFromRequest({ intent: 'change_analysis' }, 'fallback', undefined, L);
    expect(basis(buildReport(calls, r.spec, r.filters)).join(' ')).toContain('2026-10-26 to 2026-11-01');
  });
});

describe('ranking, metric-only reports and scope', () => {
  const run = (req: Parameters<typeof reportFromRequest>[0], prev?: ReturnType<typeof reportFromRequest>) => { const r = reportFromRequest(req, 'live', prev, L); return { r, d: buildReport(calls, r.spec, r.filters) }; };
  it('top 3 by answer rate: ranked table only, ties by call volume, hand-computed order', () => {
    const { r, d } = run({ intent: 'campaign_overview', metrics: ['answer_rate'], sortBy: 'answer_rate', order: 'desc', limit: 3 });
    expect(r.spec.components).toEqual(['campaign_table']);
    expect(r.spec.columns).toEqual(['answer_rate']); // only what was asked
    expect(r.title).toBe('Top 3 campaigns by answer rate');
    expect(d.rows.map((x) => x.campaignId)).toEqual(['c1', 'c3', 'c4']);
    expect(narrative(calls, d)).toBe('Top 3 campaigns by answer rate, 2026-11-02 to 2026-11-08: 1. Spring Renewal 65.0%; 2. Winback Offer 50.0%; 3. Survey Pilot 50.0%.');
  });
  it('lowest N puts missing values last and flags low samples', () => {
    const { d } = run({ intent: 'campaign_overview', sortBy: 'answer_rate', order: 'asc', limit: 3 });
    expect(d.rows.map((x) => x.campaignId)).toEqual(['c7', 'c6', 'c2']);
    expect(narrative(calls, d)).toContain('Dead Line Check 0.0% (low sample: 20 calls)');
    expect(run({ intent: 'campaign_overview', sortBy: 'answer_rate', order: 'asc' }).d.rows.at(-1)!.campaignId).toBe('c5'); // no records => last
  });
  it('only conversion rate: a single card, no chart or table', () => {
    const { r, d } = run({ intent: 'campaign_overview', metrics: ['conversion_rate'], only: true });
    expect(r.spec.components).toEqual(['conversion_card']);
    expect(narrative(calls, d)).toContain('conversion rate 23.9% (83 conversions of 348 answered)');
  });
  it('named metric without "only" keeps the default chart and table after the card', () =>
    expect(run({ intent: 'campaign_overview', metrics: ['conversion_rate'] }).r.spec.components).toEqual(['conversion_card', 'daily_trend', 'campaign_table']));
  it('a new question covers all campaigns; it does not inherit a narrowed scope; range is inherited', () => {
    const narrowed = reportFromRequest({ intent: 'campaign_overview', campaignIds: ['c1'], range: { start: '2026-10-26', end: '2026-11-01' } }, 'live', undefined, L);
    const next = reportFromRequest({ intent: 'campaign_overview', sortBy: 'answer_rate', limit: 3 }, 'live', narrowed, L);
    expect(next.filters.campaignIds).toHaveLength(7); expect(next.filters.range).toEqual({ start: '2026-10-26', end: '2026-11-01' });
  });
  it('a component-only follow-up keeps the previous campaign scope', () => {
    const narrowed = reportFromRequest({ intent: 'campaign_overview', campaignIds: ['c1'] }, 'live', undefined, L);
    expect(reportFromRequest({ intent: 'campaign_overview', components: ['daily_call_volume'] }, 'live', narrowed, L).filters.campaignIds).toEqual(['c1']);
  });
  it('singular wording for one campaign', () => {
    const { d } = run({ intent: 'campaign_overview', campaignIds: ['c1'] });
    expect(narrative(calls, d)).toContain('1 campaign placed 200 calls');
  });
});

describe('free composition', () => {
  const run = (req: Parameters<typeof reportFromRequest>[0]) => { const r = reportFromRequest(req, 'live', undefined, L); return { r, d: buildReport(calls, r.spec, r.filters) }; };
  it('only + components = exactly those components, whatever the intent', () => {
    expect(run({ intent: 'campaign_overview', components: ['change_ranking', 'daily_call_volume'], only: true }).r.spec.components).toEqual(['change_ranking', 'daily_call_volume']);
    expect(run({ intent: 'change_analysis', components: ['campaign_table'], only: true }).r.spec.components).toEqual(['campaign_table']);
  });
  it('metric cards and components combine; order of the request is irrelevant to membership', () =>
    expect(new Set(run({ intent: 'campaign_overview', metrics: ['conversion_rate'], components: ['daily_trend'], only: true }).r.spec.components)).toEqual(new Set(['conversion_card', 'daily_trend'])));
  it('without only, components are still added to the default set', () =>
    expect(run({ intent: 'change_analysis', components: ['calls_card'] }).r.spec.components).toEqual(['answer_rate_card', 'change_ranking', 'daily_trend', 'calls_card']));
  it('a custom report is titled and flagged', () => { const { r } = run({ intent: 'campaign_overview', components: ['daily_trend'], only: true }); expect(r.title).toBe('Custom report'); expect(r.spec.custom).toBe(true); });
  it('call list inside a composition takes the single named campaign and gets its own data', () => {
    const { r, d } = run({ intent: 'campaign_overview', components: ['call_list', 'answer_rate_card'], campaignIds: ['c2'], only: true });
    expect(r.spec.drill?.campaignId).toBe('c2'); expect(r.filters.campaignIds).toHaveLength(7);
    expect(d.drill!.total).toBe(expected.c2Unanswered.total);
    expect(narrative(calls, d)).toContain(`${expected.c2Unanswered.total} unanswered calls`);
  });
  it('narrative follows the components: change ranking only still concludes on the drop', () =>
    expect(narrative(calls, run({ intent: 'campaign_overview', components: ['change_ranking'], only: true }).d)).toContain('Payment Reminder dropped the most'));
});
