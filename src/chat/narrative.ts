/** Agent text for each report. Every figure comes from the report data (metrics.ts), never from the model. */
import type { CallRecord } from '../data/generate.ts';
import { drillDown, type ChangeRow } from '../query/metrics.ts';
import { campaignName, MIN_SAMPLE, type ReportData } from '../report/model.ts';
import { count, pct, pp } from '../report/format.ts';

export function narrative(calls: CallRecord[], d: ReportData): string {
  const { start, end } = d.filters.range;
  if (d.empty) return `No calls match ${start} to ${end} for the selected campaigns. Adjust the range or campaigns in the report filters.`;
  if (d.spec.components.includes('call_list') && d.spec.drill) {
    const q = { campaignId: d.spec.drill.campaignId, range: d.filters.range, pageSize: 1 };
    const n = (o?: 'no_answer' | 'busy' | 'failed') => drillDown(calls, { ...q, outcome: o }).total;
    return `${campaignName(q.campaignId)} had ${count(n())} unanswered calls between ${start} and ${end}: ${count(n('no_answer'))} no answer, ${count(n('busy'))} busy, ${count(n('failed'))} failed. Click a call for its detail.`;
  }
  if (d.spec.components.includes('change_ranking')) {
    const enough = (r: ChangeRow) => r.current.calls >= MIN_SAMPLE && r.previous.calls >= MIN_SAMPLE;
    const cmp = d.change.filter((r) => r.changePp !== null);
    if (!cmp.length) return `Answer-rate change cannot be compared: no selected campaign has calls in both ${start}–${end} and ${d.previous.start}–${d.previous.end}.`;
    const head = headline(d);
    const bigger = cmp.find((r) => !enough(r) && r.changePp! < 0 && (!head || r.changePp! < head.changePp!));
    const note = bigger ? ` ${campaignName(bigger.campaignId)} fell more (${pp(bigger.changePp)}) but has only ${count(bigger.current.calls)} / ${count(bigger.previous.calls)} calls (current / previous), below ${MIN_SAMPLE}, so it is not used as the conclusion.` : '';
    if (!head) return `No campaign with at least ${MIN_SAMPLE} calls in both periods dropped versus ${d.previous.start}–${d.previous.end}.${note}`;
    return `${campaignName(head.campaignId)} dropped the most: answer rate ${pct(head.previous.answerRate)} → ${pct(head.current.answerRate)} (${pp(head.changePp)}), ${start}–${end} versus ${d.previous.start}–${d.previous.end}.${note}`;
  }
  if (d.spec.rank) {
    const r = d.spec.rank, rows = d.rows;
    const label = { calls: 'calls', answered: 'answered calls', answer_rate: 'answer rate', conversions: 'conversions', conversion_rate: 'conversion rate', unanswered_calls: 'unanswered calls' }[r.by];
    const val = (s: ReportData['rows'][number]['summary']) => ({ calls: count(s.calls), answered: count(s.answered), answer_rate: pct(s.answerRate), conversions: count(s.conversions), conversion_rate: pct(s.conversionRate), unanswered_calls: count(s.unanswered) })[r.by];
    const list = rows.map((x, i) => `${i + 1}. ${campaignName(x.campaignId)} ${val(x.summary)}${x.summary.calls < MIN_SAMPLE ? ` (low sample: ${count(x.summary.calls)} calls)` : ''}`).join('; ');
    return `${r.order === 'asc' ? 'Lowest' : 'Top'} ${rows.length} campaigns by ${label}, ${start} to ${end}: ${list}.`;
  }
  const cards = d.spec.components.filter((c) => c.endsWith('_card'));
  if (cards.length && !d.spec.components.includes('campaign_table')) {
    const t = d.totals, bits: string[] = [];
    if (cards.includes('calls_card')) bits.push(`${count(t.calls)} calls (${count(t.answered)} answered)`);
    if (cards.includes('answer_rate_card')) bits.push(`answer rate ${pct(t.answerRate)}`);
    if (cards.includes('conversion_card')) bits.push(`conversion rate ${pct(t.conversionRate)} (${count(t.conversions)} conversions of ${count(t.answered)} answered)`);
    return `${start} to ${end}: ${bits.join(', ')}.`;
  }
  const withCalls = d.rows.filter((r) => r.summary.calls > 0 && r.summary.answerRate !== null);
  const sorted = [...withCalls].sort((a, b) => b.summary.answerRate! - a.summary.answerRate!);
  const hi = sorted[0], lo = sorted[sorted.length - 1];
  const extremes = hi && lo && hi !== lo ? ` Highest answer rate: ${campaignName(hi.campaignId)} (${pct(hi.summary.answerRate)}); lowest: ${campaignName(lo.campaignId)} (${pct(lo.summary.answerRate)}).` : '';
  return `${start} to ${end}: ${count(withCalls.length)} ${withCalls.length === 1 ? 'campaign' : 'campaigns'} placed ${count(d.totals.calls)} calls, ${pct(d.totals.answerRate)} answered, conversion ${pct(d.totals.conversionRate)}.${extremes}`;
}

/** Metric basis shown on every report (so a later question cannot silently change what a historical number meant). */
export function basis(d: ReportData): string[] {
  const b = ['Answer rate = answered ÷ calls', 'Conversion rate = conversions ÷ answered'];
  if (d.spec.components.includes('change_ranking')) b.push(`Change = current − previous period (${d.previous.start} to ${d.previous.end}), percentage points`);
  if (d.spec.components.includes('call_list')) b.push('Unanswered = no answer, busy or failed');
  return b;
}

/** The campaign a change-analysis conclusion is about: biggest drop among rows with enough calls in BOTH periods. */
export function headline(d: ReportData): ChangeRow | undefined {
  return d.change.find((r) => r.changePp !== null && r.changePp < 0 && r.current.calls >= MIN_SAMPLE && r.previous.calls >= MIN_SAMPLE);
}
