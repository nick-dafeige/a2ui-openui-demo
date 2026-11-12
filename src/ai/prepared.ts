/** Prepared analyses for the demo questions; always labelled "fallback" (FR-5, FR-31). */
import { REFERENCE } from '../data/spec.ts';
import type { AnalysisRequest } from '../query/validate.ts';
import type { PlanOutcome } from './planner.ts';

/** Browser-safe: no Node imports. */
export const PREPARED: Record<'overview' | 'change' | 'drilldown_c2', AnalysisRequest> = {
  overview: { intent: 'campaign_overview', range: REFERENCE.lastWeek },
  change: { intent: 'change_analysis', range: REFERENCE.lastWeek },
  drilldown_c2: { intent: 'unanswered_drilldown', campaignIds: ['c2'], range: REFERENCE.lastWeek },
};
export const preparedPlan = (key: keyof typeof PREPARED): PlanOutcome => ({ kind: 'plan', request: PREPARED[key], source: 'fallback' });

