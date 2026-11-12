import { CAMPAIGNS, REFERENCE } from '../data/spec.ts';
import { COMPONENTS, INTENTS, METRICS, SORTABLE, validateRequest, type AnalysisRequest } from '../query/validate.ts';
import { reserve } from './budget.ts';

export type PlanSource = 'live' | 'fallback';
export type PlanOutcome =
  | { kind: 'plan'; request: AnalysisRequest; source: PlanSource }
  | { kind: 'unknown_metric'; available: readonly string[] }
  | { kind: 'need_campaign' }
  | { kind: 'failed'; reason: string }; // caller keeps the current report and offers retry / fallback

/** Model call is injectable so tests (and the fallback path) never touch the network. */
export type Complete = (system: string, user: string) => Promise<string>;

export function systemPrompt(): string {
  const campaigns = CAMPAIGNS.map((c) => `${c.id}=${c.name}`).join(', ');
  return [
    'You convert a user question about outbound-call campaigns into ONE JSON object. Output JSON only.',
    `Allowed keys: intent, metrics, campaignIds, range, components, sortBy, order, limit, only. No other keys. Never include numbers or results.`,
    `intent: one of ${INTENTS.join(' | ')}. campaign_overview = how campaigns did; change_analysis = which changed / dropped / improved vs previous period; unanswered_drilldown = expand / drill into / show unanswered calls of ONE campaign. Any request to expand or drill into "this"/"that"/"the" campaign is unanswered_drilldown, never campaign_overview.`,
    `metrics (optional): from ${METRICS.join(', ')}. If the user asks for a metric not in this list, still output it as snake_case in metrics so the application can reject it.`,
    `campaignIds (optional): from ${campaigns}. Omit when the user does not name a campaign. The user message ends with a line "Selected campaign: <id or none>". If the user says "this/that campaign" use the selected id; if it is none and no campaign is named, omit campaignIds (the application will ask the user to choose).`,
    `range (optional): {"start":"YYYY-MM-DD","end":"YYYY-MM-DD"} inclusive. Today is ${REFERENCE.referenceDate}. "last week" = ${REFERENCE.lastWeek.start}..${REFERENCE.lastWeek.end}. Omit if not stated.`,
    `sortBy (optional, ONLY with campaign_overview): rank campaigns by one of ${SORTABLE.join(', ')}; use with campaign_overview for "top 3 campaigns by answer rate" (sortBy=answer_rate, order=desc, limit=3). order: desc = highest first (default), asc = lowest first. limit: integer 1-${CAMPAIGNS.length}. Never use limit without sortBy. Questions about change / drop / decline / improvement versus the previous period are change_analysis and NEVER use sortBy (the ranking by change is built in).`,
    `components (optional): report building blocks by id: ${COMPONENTS.join(', ')}. calls_card/answer_rate_card/conversion_card = totals; daily_trend = daily calls and answered; daily_call_volume = daily calls only; campaign_table = per-campaign comparison; change_ranking = answer-rate change vs previous period; call_list = unanswered calls of ONE campaign (then campaignIds must hold exactly that campaign).`,
    `only (optional): true when the user wants ONLY what they named, e.g. "just the conversion rate" => metrics=["conversion_rate"], only=true; "only the change ranking and a daily call volume chart" => components=["change_ranking","daily_call_volume"], only=true. Without only, components are ADDED to the default set of the intent. Pick the intent that fits the question best (campaign_overview if unsure).`,
  ].join('\n');
}

/**
 * Harmless model redundancy: change questions are ranked by change inside change_analysis, so a sortBy there (or the
 * non-sortable answer_rate_change) is dropped instead of failing the whole question. Anything else stays strict.
 */
export function normalize(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const r = { ...(raw as Record<string, unknown>) };
  const wantsChange = r.sortBy === 'answer_rate_change';
  if (wantsChange || ((r.intent === 'change_analysis' || r.intent === 'unanswered_drilldown') && r.sortBy !== undefined)) {
    if (wantsChange && r.intent === 'campaign_overview') r.intent = 'change_analysis';
    delete r.sortBy; delete r.order; delete r.limit;
  }
  return r;
}

export interface PlanContext { selectedCampaignId?: string }

export async function planQuestion(question: string, complete: Complete, ctx: PlanContext = {}): Promise<PlanOutcome> {
  let text: string;
  try { text = await complete(systemPrompt(), `${question}\nSelected campaign: ${ctx.selectedCampaignId ?? 'none'}`); } catch (e) { return { kind: 'failed', reason: `model_error: ${(e as Error).message}` }; }
  let raw: unknown;
  try { raw = JSON.parse(text.trim().replace(/^```(?:json)?|```$/g, '')); } catch { return { kind: 'failed', reason: 'model_output_not_json' }; }
  raw = normalize(raw);
  const v = validateRequest(raw);
  if (!v.ok) {
    if (v.reason === 'unknown_metric') return { kind: 'unknown_metric', available: v.availableMetrics ?? METRICS };
    return { kind: 'failed', reason: `invalid_model_plan:${v.reason}` };
  }
  const needsOne = v.request.intent === 'unanswered_drilldown' || !!v.request.components?.includes('call_list');
  if (needsOne && !(v.request.campaignIds?.length === 1)) return { kind: 'need_campaign' };
  return { kind: 'plan', request: v.request, source: 'live' };
}

export { PREPARED, preparedPlan } from './prepared.ts';

/** DeepSeek chat completion. Reserves budget first; the key is read from the environment only. `json: false` is the free-text (OpenUI Lang) channel: no response_format, so the model is not forced into JSON. */
export function deepseekComplete(opts: { reserveStage: string; fetchImpl?: typeof fetch; model?: string; timeoutMs?: number; trace?: (e: ModelTraceEvent) => void; reserveFn?: (stage: string) => number; json?: boolean; maxTokens?: number }): Complete {
  return async (system, user) => {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) { opts.trace?.({ stage: 'no_key' }); throw new Error('DEEPSEEK_API_KEY not set'); }
    let reserved: number;
    try { reserved = (opts.reserveFn ?? reserve)(opts.reserveStage); } catch (e) { opts.trace?.({ stage: 'reserve_refused', detail: (e as Error).message }); throw e; }
    opts.trace?.({ stage: 'reserved', number: reserved });
    const t0 = Date.now();
    opts.trace?.({ stage: 'sent' });
    let res: Response;
    try {
      res = await (opts.fetchImpl ?? fetch)(`${process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: opts.model ?? 'deepseek-chat', temperature: 0, ...(opts.json === false ? { max_tokens: opts.maxTokens ?? 1500 } : { response_format: { type: 'json_object' } }),
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (e) { opts.trace?.({ stage: 'transport_error', ms: Date.now() - t0, detail: (e as Error).name }); throw e; }
    opts.trace?.({ stage: 'response', status: res.status, ms: Date.now() - t0 });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = body.choices?.[0]?.message?.content;
    opts.trace?.({ stage: 'done', ms: Date.now() - t0 });
    if (typeof content !== 'string') throw new Error('empty_model_response');
    return content;
  };
}
/** The Lang channel: same budget reservation and trace events, but free text (OpenUI Lang), not forced JSON. */
export const deepseekLang = (opts: Omit<Parameters<typeof deepseekComplete>[0], 'json'>): Complete => deepseekComplete({ ...opts, json: false });

/** Optional observer events around the real request (used by the retail trace; never carries the key, prompt or reply). */
export type ModelTraceEvent =
  | { stage: 'no_key' } | { stage: 'reserve_refused'; detail: string } | { stage: 'reserved'; number: number } | { stage: 'sent' }
  | { stage: 'transport_error'; ms: number; detail: string } | { stage: 'response'; status: number; ms: number } | { stage: 'done'; ms: number };
