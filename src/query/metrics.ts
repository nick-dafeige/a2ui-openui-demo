import type { CallRecord } from '../data/generate.ts';

export interface DateRange { start: string; end: string } // inclusive YYYY-MM-DD, UTC

export interface Summary {
  calls: number;
  answered: number;
  answerRate: number | null; // null => display "—"
  conversions: number;
  conversionRate: number | null; // conversions / answered
  unanswered: number;
}

const day = (r: CallRecord) => r.startedAt.slice(0, 10);
export const inRange = (r: CallRecord, range: DateRange) => day(r) >= range.start && day(r) <= range.end;
export const isUnanswered = (r: CallRecord) => r.outcome !== 'connected';

const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

export function summarize(records: CallRecord[]): Summary {
  const answered = records.filter((r) => r.outcome === 'connected').length;
  const conversions = records.filter((r) => r.converted).length;
  return {
    calls: records.length,
    answered,
    answerRate: ratio(answered, records.length),
    conversions,
    conversionRate: ratio(conversions, answered), // denominator is answered, not calls
    unanswered: records.length - answered,
  };
}

export function previousRange(range: DateRange): DateRange {
  const ms = 86_400_000;
  const s = Date.parse(`${range.start}T00:00:00Z`);
  const e = Date.parse(`${range.end}T00:00:00Z`);
  const len = Math.round((e - s) / ms) + 1;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return { start: iso(s - len * ms), end: iso(s - ms) };
}

export interface CampaignRow { campaignId: string; summary: Summary }
export function perCampaign(records: CallRecord[], range: DateRange, campaignIds: string[]): CampaignRow[] {
  return campaignIds.map((id) => ({
    campaignId: id,
    summary: summarize(records.filter((r) => r.campaignId === id && inRange(r, range))),
  }));
}

export interface ChangeRow {
  campaignId: string;
  current: Summary;
  previous: Summary;
  /** percentage points; null => "Cannot compare" (either period has no calls). */
  changePp: number | null;
}
export function answerRateChange(records: CallRecord[], range: DateRange, campaignIds: string[]): ChangeRow[] {
  const prev = previousRange(range);
  const rows = campaignIds.map((id): ChangeRow => {
    const current = summarize(records.filter((r) => r.campaignId === id && inRange(r, range)));
    const previous = summarize(records.filter((r) => r.campaignId === id && inRange(r, prev)));
    const changePp = current.answerRate === null || previous.answerRate === null
      ? null
      : Math.round((current.answerRate - previous.answerRate) * 1e8) / 1e6; // rounded so float noise cannot reorder ties
    return { campaignId: id, current, previous, changePp };
  });
  // Most negative first; non-comparable rows last (never treated as zero).
  return rows.sort((a, b) => (a.changePp ?? Infinity) - (b.changePp ?? Infinity) || a.campaignId.localeCompare(b.campaignId));
}

export interface DailyPoint { date: string; calls: number; answered: number; answerRate: number | null }
export function dailyTrend(records: CallRecord[], range: DateRange, campaignIds?: string[]): DailyPoint[] {
  const out: DailyPoint[] = [];
  for (let t = Date.parse(`${range.start}T00:00:00Z`); t <= Date.parse(`${range.end}T00:00:00Z`); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const rs = records.filter((r) => day(r) === date && (!campaignIds || campaignIds.includes(r.campaignId)));
    const s = summarize(rs);
    out.push({ date, calls: s.calls, answered: s.answered, answerRate: s.answerRate });
  }
  return out;
}

export type OutcomeFilter = 'no_answer' | 'busy' | 'failed';
export interface DrillQuery {
  campaignId: string; range: DateRange; outcome?: OutcomeFilter;
  sort?: 'asc' | 'desc'; page?: number; pageSize?: number;
}
export interface DrillResult { total: number; page: number; pageSize: number; rows: CallRecord[] }
export function drillDown(records: CallRecord[], q: DrillQuery): DrillResult {
  const pageSize = q.pageSize ?? 10;
  const page = q.page ?? 1;
  const filtered = records
    .filter((r) => r.campaignId === q.campaignId && inRange(r, q.range) && isUnanswered(r) && (!q.outcome || r.outcome === q.outcome))
    .sort((a, b) => (q.sort === 'asc' ? 1 : -1) * a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  return { total: filtered.length, page, pageSize, rows: filtered.slice((page - 1) * pageSize, page * pageSize) };
}
