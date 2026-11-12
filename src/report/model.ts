import type { CallRecord } from '../data/generate.ts';
import { CAMPAIGNS, REFERENCE } from '../data/spec.ts';
import { answerRateChange, dailyTrend, drillDown, perCampaign, previousRange, summarize, inRange, type CampaignRow, type ChangeRow, type DailyPoint, type DateRange, type DrillResult, type Summary } from '../query/metrics.ts';
import { COMPONENT_IDS, type ComponentId } from '../layout/components.ts';

export type Intent = 'campaign_overview' | 'change_analysis' | 'unanswered_drilldown';
/** What to show (decided from the model plan or a prepared analysis). Filters are separate and user-owned. */
export type OutcomeFilter = 'no_answer' | 'busy' | 'failed';
export interface DrillSpec { campaignId: string; outcome?: OutcomeFilter; sort: 'asc' | 'desc'; page: number }
export type RankMetric = 'calls' | 'answered' | 'answer_rate' | 'conversions' | 'conversion_rate' | 'unanswered_calls';
export interface Rank { by: RankMetric; order: 'asc' | 'desc'; limit?: number }
export interface ReportSpec { /** true = the user composed an exact component set (only + components) */ custom?: boolean; intent: Intent; components: ComponentId[]; drill?: DrillSpec; rank?: Rank; /** Campaign-table metric columns; undefined = all. A ranking shows only what was asked. */ columns?: RankMetric[] }
/** A period with fewer calls than this is flagged "low sample" and is not used as a headline conclusion. */
export const MIN_SAMPLE = 30;
export const PAGE_SIZE = 10;
export interface Filters { range: DateRange; campaignIds: string[] }

export const ALL_CAMPAIGN_IDS = CAMPAIGNS.map((c) => c.id);
export const defaultFilters = (): Filters => ({ range: { ...REFERENCE.lastWeek }, campaignIds: [...ALL_CAMPAIGN_IDS] });
export const campaignName = (id: string) => CAMPAIGNS.find((c) => c.id === id)?.name ?? id;

const BASE: Record<Intent, ComponentId[]> = {
  campaign_overview: ['calls_card', 'answer_rate_card', 'conversion_card', 'daily_trend', 'campaign_table'],
  change_analysis: ['answer_rate_card', 'change_ranking', 'daily_trend'],
  unanswered_drilldown: ['call_list'],
};
const CARD_FOR_METRIC: Record<string, ComponentId> = {
  calls: 'calls_card', answered: 'calls_card', answer_rate: 'answer_rate_card', conversions: 'conversion_card', conversion_rate: 'conversion_card',
};
export interface SpecOptions { metrics?: string[]; only?: boolean; rank?: Rank }
/**
 * Components for an intent. campaign_overview only: a ranking asks for the ranked table alone; named metrics narrow the
 * cards, and with `only` nothing else is added (otherwise the default chart and table follow).
 */
export const specFor = (intent: Intent, extra: string[] = [], drillCampaignId?: string, opts: SpecOptions = {}): ReportSpec => {
  const valid = extra.filter((c): c is ComponentId => (COMPONENT_IDS as readonly string[]).includes(c));
  const cards = [...new Set((opts.metrics ?? []).map((m) => CARD_FOR_METRIC[m]).filter(Boolean))] as ComponentId[];
  let base = BASE[intent];
  let rank: Rank | undefined;
  let columns: RankMetric[] | undefined;
  if (opts.rank && intent === 'campaign_overview') {
    rank = opts.rank; base = ['campaign_table'];
    columns = [...new Set<RankMetric>([opts.rank.by, ...(opts.metrics ?? []).filter((m): m is RankMetric => m in KEY)])];
  } else if (intent === 'campaign_overview' && cards.length) base = opts.only ? cards : [...cards, 'daily_trend', 'campaign_table'];
  // Exact composition: "only" with named components (and/or metric cards) = exactly those, whatever the intent.
  const custom = !!opts.only && (valid.length > 0 || (cards.length > 0 && intent !== 'campaign_overview'));
  if (custom) base = [...(rank ? ['campaign_table' as ComponentId] : []), ...cards];
  const components = [...new Set<ComponentId>([...base, ...valid])];
  return { intent, rank, columns, custom: custom || undefined, components, drill: drillCampaignId ? { campaignId: drillCampaignId, sort: 'desc', page: 1 } : undefined };
};

const KEY: Record<RankMetric, (s: Summary) => number | null> = {
  calls: (s) => s.calls, answered: (s) => s.answered, answer_rate: (s) => s.answerRate, conversions: (s) => s.conversions,
  conversion_rate: (s) => s.conversionRate, unanswered_calls: (s) => s.unanswered,
};
/** Rank campaign rows; missing values (null) always last, ties by call volume then id. */
export function rankRows(rows: CampaignRow[], rank: Rank): CampaignRow[] {
  const k = KEY[rank.by], dir = rank.order === 'asc' ? 1 : -1;
  const sorted = [...rows].sort((a, b) => {
    const x = k(a.summary), y = k(b.summary);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return dir * (x - y) || b.summary.calls - a.summary.calls || a.campaignId.localeCompare(b.campaignId);
  });
  return rank.limit ? sorted.slice(0, rank.limit) : sorted;
}

export interface ReportData {
  spec: ReportSpec;
  filters: Filters;
  previous: DateRange;
  totals: Summary;
  rows: CampaignRow[];
  change: ChangeRow[];
  trend: DailyPoint[];
  drill: (DrillResult & { pages: number }) | null;
  empty: boolean;
}

/** All numbers in the UI come from here (FR-4). */
export function buildReport(calls: CallRecord[], spec: ReportSpec, filters: Filters): ReportData {
  const inScope = calls.filter((r) => filters.campaignIds.includes(r.campaignId) && inRange(r, filters.range));
  const totals = summarize(inScope);
  return {
    spec, filters,
    previous: previousRange(filters.range),
    totals,
    rows: spec.rank ? rankRows(perCampaign(calls, filters.range, filters.campaignIds), spec.rank) : perCampaign(calls, filters.range, filters.campaignIds),
    change: answerRateChange(calls, filters.range, filters.campaignIds),
    trend: dailyTrend(calls, filters.range, filters.campaignIds),
    drill: spec.drill ? withPages(drillDown(calls, { campaignId: spec.drill.campaignId, range: filters.range, outcome: spec.drill.outcome, sort: spec.drill.sort, page: spec.drill.page, pageSize: PAGE_SIZE })) : null,
    empty: totals.calls === 0,
  };
}

const withPages = (d: DrillResult) => ({ ...d, pages: Math.max(1, Math.ceil(d.total / d.pageSize)) });
