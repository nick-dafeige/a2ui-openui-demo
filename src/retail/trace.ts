/**
 * Per-turn trace of a natural-language message: browser Send -> /api/retail/interpret -> DeepSeek (one call, or two when the
 * model asked for business tools). Browser-safe, pure. Records ids, whether a model request was really sent, failure reasons and
 * timings. It never contains the API key, the prompts, the user's message text or the model's reply (only lengths, tool names
 * and component names).
 */
import type { TurnOk } from './turn.ts';
import type { LangPayload } from './openui/compose.ts';

export type CallStage = 'plan' | 'compose' | 'lang' | 'repair';

/** Events emitted around each real DeepSeek request (see `deepseekComplete`). */
export type ModelEvent =
  | { stage: 'no_key' }
  | { stage: 'reserve_refused'; detail: string }
  | { stage: 'reserved'; number: number }
  | { stage: 'sent' }
  | { stage: 'transport_error'; ms: number; detail: string }
  | { stage: 'response'; status: number; ms: number }   // response headers received (first byte)
  | { stage: 'done'; ms: number };                      // full response body read

export type ServerOutcome = 'ok' | 'ok_nothing_actionable' | 'failed';
export interface CallTrace { stage: CallStage; modelCalled: boolean; httpStatus: number | null; ttfbMs: number | null; modelMs: number | null; budgetReservation: number | null; failure: string | null }
export interface TurnTrace { mode: string; tools: string[]; ui: string[]; guardOk: boolean; answerReplaced: boolean; ignoredChanges: boolean; droppedQuick?: number; changeKeys: string[]; lang?: { ok: boolean; attempts: number; repaired: boolean; components: string[]; errors: number; programChars: number } }
export interface ServerTrace {
  requestId: string; at: string;
  mode: 'live' | 'stub-fail' | 'stub-invalid';   // server mode; stubs never send a model request
  messageChars: number; contextChars: number;
  modelCalled: boolean;                           // true only when at least one HTTP request to the model provider was actually sent
  model: string | null; httpStatus: number | null; ttfbMs: number | null; modelMs: number | null; budgetReservation: number | null;   // totals/last over the calls below
  calls: CallTrace[];
  turn: TurnTrace | null;
  outcome: ServerOutcome; failure: string | null; totalMs: number;
}
export interface TurnResponse extends Omit<TurnOk, 'stages'> { trace: ServerTrace; lang?: LangPayload }
export interface FailedResponse { kind: 'failed'; reason: string; trace: ServerTrace }

export const newRequestId = (): string => `rq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
export const validRequestId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(s);

function callTrace(stage: CallStage, events: ModelEvent[]): CallTrace {
  const sent = events.some((e) => e.stage === 'sent');
  const resp = events.find((e): e is Extract<ModelEvent, { stage: 'response' }> => e.stage === 'response');
  const done = events.find((e): e is Extract<ModelEvent, { stage: 'done' }> => e.stage === 'done');
  const transport = events.find((e): e is Extract<ModelEvent, { stage: 'transport_error' }> => e.stage === 'transport_error');
  const reserved = events.find((e): e is Extract<ModelEvent, { stage: 'reserved' }> => e.stage === 'reserved');
  const refused = events.find((e): e is Extract<ModelEvent, { stage: 'reserve_refused' }> => e.stage === 'reserve_refused');
  const failure = events.some((e) => e.stage === 'no_key') ? 'no_api_key' : refused ? refused.detail : transport ? `transport_error:${transport.detail}` : resp && resp.status >= 400 ? `http_${resp.status}` : null;
  return { stage, modelCalled: sent, httpStatus: resp?.status ?? null, ttfbMs: resp?.ms ?? null, modelMs: done?.ms ?? resp?.ms ?? transport?.ms ?? null, budgetReservation: reserved?.number ?? null, failure };
}

type BuildOutcome = { kind: 'turn'; plan: TurnOk['plan']; guard: TurnOk['guard']; results: TurnOk['results']; ignoredChanges: boolean; droppedQuick?: number; lang?: LangPayload } | { kind: 'failed'; reason: string };
/** Build the server-side record from what actually happened. `calls` is one entry per real model request attempt. */
export function buildServerTrace(a: { requestId: string; at: string; mode: ServerTrace['mode']; messageChars: number; contextChars: number; calls: { stage: CallStage; events: ModelEvent[] }[]; outcome: BuildOutcome; model: string; totalMs: number }): ServerTrace {
  const calls = a.calls.map((c) => callTrace(c.stage, c.events));
  const sent = calls.filter((c) => c.modelCalled);
  const o = a.outcome;
  const turn: TurnTrace | null = o.kind === 'turn' ? { mode: o.plan.mode, tools: o.results.map((r) => r.tool), ui: o.plan.ui.map((u) => u.component), guardOk: o.guard.ok, answerReplaced: o.guard.replaced, ignoredChanges: o.ignoredChanges, droppedQuick: o.droppedQuick, changeKeys: Object.keys(o.plan.changes), ...(o.lang ? { lang: { ok: o.lang.ok, attempts: o.lang.attempts, repaired: o.lang.repaired, components: o.lang.components, errors: o.lang.errors.length, programChars: o.lang.raw.length } } : {}) } : null;
  const outcome: ServerOutcome = o.kind === 'failed' ? 'failed' : !o.lang && o.plan.mode === 'change' && !o.plan.answer && Object.keys(o.plan.changes).length === 0 && o.plan.ui.length === 0 ? 'ok_nothing_actionable' : 'ok';
  const sum = (f: (c: CallTrace) => number | null) => { const v = sent.map(f).filter((x): x is number => x != null); return v.length ? v.reduce((x, y) => x + y, 0) : null; };
  return {
    requestId: a.requestId, at: a.at, mode: a.mode, messageChars: a.messageChars, contextChars: a.contextChars,
    modelCalled: sent.length > 0, model: sent.length ? a.model : null, httpStatus: [...sent].reverse().find((c) => c.httpStatus != null)?.httpStatus ?? null,
    ttfbMs: sent[0]?.ttfbMs ?? null, modelMs: sum((c) => c.modelMs), budgetReservation: [...sent].reverse().find((c) => c.budgetReservation != null)?.budgetReservation ?? null,
    calls, turn, outcome, failure: o.kind === 'failed' ? o.reason : null, totalMs: a.totalMs,
  };
}

// ---------------- what the browser records and shows ----------------
export type Route = 'model' | 'rules_only' | 'rules_chosen' | 'action';
export interface ClientTrace {
  requestId: string; route: Route; sentAt: string; roundTripMs: number | null;
  server: ServerTrace | null;                 // null when the server was not reached (rules-only mode, network error)
  outcome: 'model_ok' | 'model_ok_nothing_actionable' | 'model_failed' | 'rules';
  failure: string | null; retryOf: string | null;
}
/** The label may say "Understood by model" ONLY if the server proves a model request was sent and it succeeded. */
export function viaLabel(t: Pick<ClientTrace, 'route' | 'outcome' | 'server'>): 'model' | 'rules_only' | 'rules_chosen' | 'failed' | 'action' {
  if (t.route === 'action') return 'action';
  if (t.route === 'rules_only') return 'rules_only';
  if (t.route === 'rules_chosen') return 'rules_chosen';
  return (t.outcome === 'model_ok' || t.outcome === 'model_ok_nothing_actionable') && t.server?.modelCalled === true && t.server.outcome !== 'failed' ? 'model' : 'failed';
}
/** Reject a server answer that claims success without proof of a real model request (never trust the happy path blindly). */
export function checkResponse(r: unknown, requestId: string): { ok: true; turn: TurnResponse } | { ok: false; reason: string; trace: ServerTrace | null } {
  const o = r as { kind?: string; reason?: string; trace?: ServerTrace; plan?: unknown; results?: unknown } | null;
  const trace = o && typeof o === 'object' && o.trace && typeof o.trace === 'object' ? (o.trace as ServerTrace) : null;
  if (!o || typeof o !== 'object') return { ok: false, reason: 'bad_response', trace };
  if (o.kind === 'failed') return { ok: false, reason: String(o.reason ?? 'unknown'), trace };
  if (o.kind !== 'turn' || !o.plan || typeof o.plan !== 'object' || !Array.isArray(o.results)) return { ok: false, reason: 'bad_response', trace };
  if (!trace || trace.requestId !== requestId) return { ok: false, reason: 'trace_missing_or_mismatched', trace };
  if (trace.modelCalled !== true || trace.outcome === 'failed') return { ok: false, reason: 'server_claimed_success_without_a_model_call', trace };
  return { ok: true, turn: o as TurnResponse };
}
export const describeTrace = (t: ClientTrace): string => {
  const parts = [t.requestId];
  if (t.route === 'model' || t.route === 'rules_chosen') {
    const s = t.server;
    parts.push(s ? (s.modelCalled ? `model called (${s.model}${s.httpStatus ? `, HTTP ${s.httpStatus}` : ''})` : 'model NOT called') : 'server not reached');
    if (s && s.calls.filter((c) => c.modelCalled).length > 1) parts.push(`${s.calls.length} calls: ${s.calls.map((c) => `${c.stage} ${c.modelMs ?? '?'} ms`).join(', ')}`);
    else if (s?.modelMs != null) parts.push(`model ${s.modelMs} ms${s.ttfbMs != null && s.ttfbMs !== s.modelMs ? ` (first byte ${s.ttfbMs} ms)` : ''}`);
    if (s) parts.push(`server ${s.totalMs} ms`);
    if (s?.turn) parts.push(`${s.turn.mode}${s.turn.tools.length ? ` · tools ${s.turn.tools.join('+')}` : ''}${s.turn.ui.length ? ` · ui ${s.turn.ui.join('+')}` : ''}${s.turn.answerReplaced ? ' · wording replaced by guard' : ''}${s.turn.ignoredChanges ? ' · state changes ignored' : ''}${s.turn.droppedQuick ? ` · ${s.turn.droppedQuick} invalid suggestion(s) dropped` : ''}${s.turn.lang ? ` · OpenUI Lang ${s.turn.lang.ok ? 'validated' : 'REJECTED'}${s.turn.lang.repaired ? ' after 1 repair' : ''} (${s.turn.lang.components.join('+') || 'text only'})` : ''}`);
  } else if (t.route === 'rules_only') parts.push('rules-only mode: model NOT called');
  if (t.roundTripMs != null) parts.push(`round trip ${t.roundTripMs} ms`);
  if (t.failure) parts.push(`failure: ${t.failure}`);
  return parts.join(' · ');
};
