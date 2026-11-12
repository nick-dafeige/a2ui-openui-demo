/** Message and report state for the chat stream. Pure functions: every report is owned by its message. */
import type { AnalysisRequest } from '../query/validate.ts';
import type { PlanSource } from '../ai/planner.ts';
import type { Layout } from '../layout/components.ts';
import { defaultFilters, specFor, type Filters, type Intent, type ReportSpec } from '../report/model.ts';

/** 'action' = produced by a UI click (drill-down), no model involved. */
export type ReportSource = PlanSource | 'action';
export interface ReportInstance {
  id: string;
  title: string;
  spec: ReportSpec;
  filters: Filters;          // current (user may adjust inside this message)
  askedFilters: Filters;     // as originally queried; shown so later edits are visible
  layout: Layout;            // this report's own layout (copy of the preference at creation)
  source: ReportSource;
  request?: AnalysisRequest;
  openCallId: string | null;
  editing: boolean;
}
export type Msg =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'action'; text: string }
  | { id: string; role: 'agent'; text: string; report?: ReportInstance; choose?: boolean; error?: { reason: string; question: string }; pending?: boolean };

let seq = 0;
export const nextId = (p: string) => `${p}${++seq}`;

export const TITLES: Record<Intent, string> = { campaign_overview: 'Campaign overview', change_analysis: 'Answer-rate change', unanswered_drilldown: 'Unanswered calls' };
const clone = (f: Filters): Filters => ({ range: { ...f.range }, campaignIds: [...f.campaignIds] });

export const latestReport = (msgs: Msg[]): ReportInstance | undefined => {
  for (let i = msgs.length - 1; i >= 0; i--) { const m = msgs[i]; if (m.role === 'agent' && m.report) return m.report; }
  return undefined;
};
/** The campaign "this campaign" refers to: the latest drilled report's campaign. */
export const selectedCampaign = (msgs: Msg[]): string | undefined => {
  for (let i = msgs.length - 1; i >= 0; i--) { const m = msgs[i]; if (m.role === 'agent' && m.report?.spec.drill) return m.report.spec.drill.campaignId; }
  return undefined;
};

/** New report from a validated plan. Filters come from the request, else from the latest report, else defaults; history is never touched. */
export function reportFromRequest(req: AnalysisRequest, source: PlanSource, prev: ReportInstance | undefined, layoutPref: Layout): ReportInstance {
  const intent = req.intent as Intent;
  // The call list needs exactly one campaign, whichever intent the user's composition has.
  const wantsCalls = intent === 'unanswered_drilldown' || !!req.components?.includes('call_list');
  const drill = wantsCalls ? req.campaignIds?.[0] : undefined;
  const shaped = !!(req.metrics?.length || req.only || req.sortBy);
  // A component-only follow-up of the same intent modifies the previous report (same scope, new NEW message).
  const extend = !!(prev && req.components?.length && !req.campaignIds && !shaped && req.intent === prev.spec.intent);
  // Range follows the conversation; the campaign scope does NOT: a new question covers all campaigns unless it names some.
  const filters: Filters = {
    range: req.range ? { ...req.range } : prev ? { ...prev.filters.range } : defaultFilters().range,
    campaignIds: !wantsCalls && req.campaignIds?.length ? [...req.campaignIds] : extend ? [...prev!.filters.campaignIds] : defaultFilters().campaignIds,
  };
  const spec = extend ? { ...prev!.spec, components: specFor(prev!.spec.intent, [...prev!.spec.components, ...req.components!]).components } : specFor(intent, req.components ?? [], drill, { metrics: req.metrics, only: req.only, rank: req.sortBy ? { by: req.sortBy, order: req.order ?? 'desc', limit: req.limit } : undefined });
  const RANK_LABEL = { calls: 'calls', answered: 'answered calls', answer_rate: 'answer rate', conversions: 'conversions', conversion_rate: 'conversion rate', unanswered_calls: 'unanswered calls' } as const;
  const title = spec.custom ? 'Custom report' : spec.rank ? `${spec.rank.order === 'asc' ? 'Lowest' : 'Top'} ${spec.rank.limit ?? 'all'} campaigns by ${RANK_LABEL[spec.rank.by]}` : TITLES[intent];
  return { id: nextId('r'), title, spec, filters, askedFilters: clone(filters), layout: layoutPref, source, request: req, openCallId: null, editing: false };
}

/** Drill-down from an existing report: frozen scope (range) of the source report, new report. */
export function drillReport(from: ReportInstance, campaignId: string, layoutPref: Layout): ReportInstance {
  const filters = clone(from.filters);
  return { id: nextId('r'), title: TITLES.unanswered_drilldown, spec: specFor('unanswered_drilldown', [], campaignId), filters, askedFilters: clone(filters), layout: layoutPref, source: 'action', openCallId: null, editing: false };
}

/** Replace one message's report; every other message is returned as the same object. */
export const patchReport = (msgs: Msg[], reportId: string, fn: (r: ReportInstance) => ReportInstance): Msg[] =>
  msgs.map((m) => (m.role === 'agent' && m.report?.id === reportId ? { ...m, report: fn(m.report) } : m));
