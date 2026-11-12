import { CAMPAIGNS } from '../data/spec.ts';
import { COMPONENT_IDS } from '../layout/components.ts';

export const METRICS = ['calls', 'answered', 'answer_rate', 'conversions', 'conversion_rate', 'answer_rate_change', 'unanswered_calls'] as const;
export const INTENTS = ['campaign_overview', 'change_analysis', 'unanswered_drilldown'] as const;
export const COMPONENTS = COMPONENT_IDS;
/** Metrics a campaign list can be ranked by (answer_rate_change has its own intent). */
export const SORTABLE = ['calls', 'answered', 'answer_rate', 'conversions', 'conversion_rate', 'unanswered_calls'] as const;

export interface AnalysisRequest {
  intent: (typeof INTENTS)[number];
  metrics?: string[];
  campaignIds?: string[];
  range?: { start: string; end: string };
  components?: string[];
  /** Rank campaigns: sortBy + order (default desc) + limit (top/bottom N). */
  sortBy?: (typeof SORTABLE)[number];
  order?: 'asc' | 'desc';
  limit?: number;
  /** Show only the components of the named metrics (no default chart/table). */
  only?: boolean;
}
export type Validation = { ok: true; request: AnalysisRequest } | { ok: false; reason: string; availableMetrics?: readonly string[] };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Untrusted model JSON in, either a whitelisted request or a rejection out (FR-2, FR-4). */
export function validateRequest(raw: unknown): Validation {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'not_an_object' };
  const r = raw as Record<string, unknown>;
  if (!(INTENTS as readonly unknown[]).includes(r.intent)) return { ok: false, reason: 'unsupported_intent' };
  const strs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (r.metrics !== undefined) {
    if (!strs(r.metrics)) return { ok: false, reason: 'bad_metrics' };
    if ((r.metrics as string[]).some((m) => !(METRICS as readonly string[]).includes(m)))
      return { ok: false, reason: 'unknown_metric', availableMetrics: METRICS };
  }
  if (r.campaignIds !== undefined) {
    if (!strs(r.campaignIds)) return { ok: false, reason: 'bad_campaigns' };
    if ((r.campaignIds as string[]).some((c) => !CAMPAIGNS.some((k) => k.id === c))) return { ok: false, reason: 'unknown_campaign' };
  }
  if (r.components !== undefined) {
    if (!strs(r.components)) return { ok: false, reason: 'bad_components' };
    if ((r.components as string[]).some((c) => !(COMPONENTS as readonly string[]).includes(c))) return { ok: false, reason: 'unknown_component' };
  }
  if (r.range !== undefined) {
    const g = r.range as { start?: unknown; end?: unknown };
    if (typeof g?.start !== 'string' || typeof g?.end !== 'string' || !DATE.test(g.start) || !DATE.test(g.end) || g.start > g.end)
      return { ok: false, reason: 'bad_range' };
  }
  if (r.sortBy !== undefined && !(SORTABLE as readonly unknown[]).includes(r.sortBy)) return { ok: false, reason: 'bad_sort' };
  if (r.order !== undefined && r.order !== 'asc' && r.order !== 'desc') return { ok: false, reason: 'bad_order' };
  if (r.limit !== undefined && !(Number.isInteger(r.limit) && (r.limit as number) >= 1 && (r.limit as number) <= CAMPAIGNS.length)) return { ok: false, reason: 'bad_limit' };
  if (r.only !== undefined && typeof r.only !== 'boolean') return { ok: false, reason: 'bad_only' };
  if ((r.order !== undefined || r.limit !== undefined) && r.sortBy === undefined) return { ok: false, reason: 'order_without_sort' };
  // Extra keys (e.g. model-supplied "numbers") are rejected: the model never supplies figures.
  const allowed = new Set(['intent', 'metrics', 'campaignIds', 'range', 'components', 'sortBy', 'order', 'limit', 'only']);
  if (Object.keys(r).some((k) => !allowed.has(k))) return { ok: false, reason: 'unexpected_field' };
  return { ok: true, request: r as unknown as AnalysisRequest };
}
