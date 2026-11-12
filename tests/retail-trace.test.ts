import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deepseekComplete, type ModelTraceEvent } from '../src/ai/planner.ts';
import { initialTask } from '../src/retail/state.ts';
import { scenarioById } from '../src/retail/data.ts';
import { runTurn, type Stage } from '../src/retail/turn.ts';
import { buildServerTrace, checkResponse, describeTrace, newRequestId, validRequestId, viaLabel, type ClientTrace, type ServerTrace } from '../src/retail/trace.ts';

const KEY = 'sk-test-secret-value-1234';
let saved: string | undefined;
beforeEach(() => { saved = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = KEY; });
afterEach(() => { if (saved === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved; });

const reply = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });
const content = (plan: unknown) => reply({ choices: [{ message: { content: JSON.stringify(plan) } }] });
/** a real runTurn over deepseekComplete with an injected fetch: one events list per model call, like the dev server does */
async function run(opts: Partial<Parameters<typeof deepseekComplete>[0]>, message = 'hello') {
  const calls: { stage: Stage; events: ModelTraceEvent[] }[] = [];
  const outcome = await runTurn({ message, history: [], task: initialTask(scenarioById('standard')) }, async (stage, system, user) => {
    const entry = { stage, events: [] as ModelTraceEvent[] }; calls.push(entry);
    return deepseekComplete({ reserveStage: 't', reserveFn: () => 7, trace: (e) => entry.events.push(e), ...opts })(system, user);
  });
  const trace = buildServerTrace({ requestId: 'rq-test-1', at: 'now', mode: 'live', messageChars: message.length, contextChars: 3, calls, outcome: outcome.kind === 'turn' ? outcome : { kind: 'failed', reason: outcome.reason }, model: 'deepseek-chat', totalMs: 12 });
  return { calls, outcome, trace };
}
const okPlan = content({ mode: 'discuss', answer: 'Nothing to compare yet.' });

describe('server trace: "model called" means an HTTP request was really sent', () => {
  it('success: reserved -> sent -> response -> done; turn summary has mode and names, no message text', async () => {
    const r = await run({ fetchImpl: okPlan as never }, 'my secret message text');
    expect(r.calls[0].events.map((e) => e.stage)).toEqual(['reserved', 'sent', 'response', 'done']);
    expect(r.trace).toMatchObject({ modelCalled: true, model: 'deepseek-chat', httpStatus: 200, budgetReservation: 7, outcome: 'ok', failure: null, messageChars: 22 });
    expect(r.trace.turn).toMatchObject({ mode: 'discuss', tools: [], ui: [], guardOk: true });
    expect(r.trace.calls).toHaveLength(1);
    expect(r.trace.modelMs).toBeGreaterThanOrEqual(r.trace.ttfbMs!);
    expect(JSON.stringify(r.trace)).not.toContain('secret message');
    expect(JSON.stringify(r.trace)).not.toContain('Nothing to compare');        // not the model's reply either
    expect(JSON.stringify(r.trace)).not.toContain(KEY);
  });
  it('two calls when the model asks for a tool: both are recorded, totals add up', async () => {
    let n = 0;
    const fetchImpl = (async () => (++n === 1 ? content({ mode: 'what_if', queries: [{ id: 'q1', tool: 'policy_terms', args: {} }] })() : content({ answer: 'Terms are shown.' })())) as never;
    const r = await run({ fetchImpl });
    expect(r.trace.calls.map((c) => [c.stage, c.modelCalled, c.httpStatus])).toEqual([['plan', true, 200], ['compose', true, 200]]);
    expect(r.trace.turn).toMatchObject({ mode: 'what_if', tools: ['policy_terms'] });
    expect(r.trace.modelMs).toBe(r.trace.calls.reduce((x, c) => x + (c.modelMs ?? 0), 0));
    expect(r.trace.budgetReservation).toBe(7);
  });
  it('provider error: the request WAS sent, status and failure recorded', async () => {
    const r = await run({ fetchImpl: reply({}, 503) as never });
    expect(r.trace).toMatchObject({ modelCalled: true, httpStatus: 503, outcome: 'failed' });
    expect(r.trace.failure).toContain('http_503');
    expect(r.trace.calls[0].failure).toBe('http_503');
  });
  it('timeout / network error: sent, no status, failure named', async () => {
    const r = await run({ fetchImpl: (async () => { throw Object.assign(new Error('x'), { name: 'TimeoutError' }); }) as never });
    expect(r.trace).toMatchObject({ modelCalled: true, httpStatus: null, outcome: 'failed' });
    expect(r.calls[0].events.at(-1)).toMatchObject({ stage: 'transport_error', detail: 'TimeoutError' });
    expect(r.trace.calls[0].failure).toBe('transport_error:TimeoutError');
  });
  it('no key: nothing is sent', async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const r = await run({ fetchImpl: (async () => { throw new Error('must not be called'); }) as never });
    expect(r.trace).toMatchObject({ modelCalled: false, model: null, outcome: 'failed' });
    expect(r.trace.calls[0]).toMatchObject({ modelCalled: false, failure: 'no_api_key' });
  });
  it('budget refused: nothing is sent, the reason is kept', async () => {
    const r = await run({ reserveFn: () => { throw new Error('paid_request_budget_exhausted_or_not_authorised'); }, fetchImpl: (async () => { throw new Error('must not be called'); }) as never });
    expect(r.trace).toMatchObject({ modelCalled: false, budgetReservation: null, outcome: 'failed' });
    expect(r.trace.calls[0].failure).toContain('paid_request_budget_exhausted');
  });
  it('model returned an invalid plan: a call was made, the result is a failure (no silent rules)', async () => {
    const r = await run({ fetchImpl: content({ mode: 'discuss', price: 1 }) as never });
    expect(r.trace).toMatchObject({ modelCalled: true, outcome: 'failed' });
    expect(r.trace.failure).toBe('invalid_turn_plan:unknown_key:price');
  });
});

const server = (o: Partial<ServerTrace> = {}): ServerTrace => ({ requestId: 'rq-abc-1', at: 'now', mode: 'live', messageChars: 5, contextChars: 5, modelCalled: true, model: 'deepseek-chat', httpStatus: 200, ttfbMs: 120, modelMs: 700, budgetReservation: 1, calls: [{ stage: 'plan', modelCalled: true, httpStatus: 200, ttfbMs: 120, modelMs: 700, budgetReservation: 1, failure: null }], turn: { mode: 'discuss', tools: [], ui: [], guardOk: true, answerReplaced: false, ignoredChanges: false, changeKeys: [] }, outcome: 'ok', failure: null, totalMs: 710, ...o });
const client = (o: Partial<ClientTrace> = {}): ClientTrace => ({ requestId: 'rq-abc-1', route: 'model', sentAt: 'now', roundTripMs: 720, server: server(), outcome: 'model_ok', failure: null, retryOf: null, ...o });
const turnBody = (trace: ServerTrace) => ({ kind: 'turn', plan: { mode: 'discuss', changes: {}, answer: 'a', ui: [], quick: [] }, results: [], memo: '', guard: { ok: true, violations: [], replaced: false }, ignoredChanges: false, trace });

describe('the "Understood by model" label has to be earned', () => {
  it('model label only with proof of a real call and a successful outcome', () => {
    expect(viaLabel(client())).toBe('model');
    expect(viaLabel(client({ outcome: 'model_ok_nothing_actionable' }))).toBe('model');
    expect(viaLabel(client({ server: server({ modelCalled: false }) }))).toBe('failed');
    expect(viaLabel(client({ server: null }))).toBe('failed');
    expect(viaLabel(client({ server: server({ outcome: 'failed' }) }))).toBe('failed');
    expect(viaLabel(client({ outcome: 'model_failed' }))).toBe('failed');
  });
  it('rules and actions never carry the model label', () => {
    expect(viaLabel(client({ route: 'rules_only', outcome: 'rules', server: null }))).toBe('rules_only');
    expect(viaLabel(client({ route: 'rules_chosen', outcome: 'rules', server: null }))).toBe('rules_chosen');
    expect(viaLabel(client({ route: 'action', outcome: 'rules', server: null }))).toBe('action');
  });
  it('checkResponse rejects a success claim that has no model call, a missing trace or another request id', () => {
    expect(checkResponse(turnBody(server()), 'rq-abc-1').ok).toBe(true);
    expect(checkResponse(turnBody(server({ modelCalled: false })), 'rq-abc-1')).toMatchObject({ ok: false, reason: 'server_claimed_success_without_a_model_call' });
    expect(checkResponse({ ...turnBody(server()), trace: undefined }, 'rq-abc-1')).toMatchObject({ ok: false, reason: 'trace_missing_or_mismatched' });
    expect(checkResponse(turnBody(server({ requestId: 'rq-other-9' })), 'rq-abc-1')).toMatchObject({ ok: false, reason: 'trace_missing_or_mismatched' });
    expect(checkResponse({ kind: 'failed', reason: 'http_503', trace: server({ outcome: 'failed' }) }, 'rq-abc-1')).toMatchObject({ ok: false, reason: 'http_503' });
    expect(checkResponse({ kind: 'intent', intent: {}, trace: server() }, 'rq-abc-1')).toMatchObject({ ok: false, reason: 'bad_response' });   // the old label-only shape is gone
    expect(checkResponse('nope', 'rq-abc-1').ok).toBe(false);
  });
});

describe('ids and the human-readable line', () => {
  it('request ids are unique and validated', () => {
    const a = newRequestId(), b = newRequestId();
    expect(a).not.toBe(b);
    expect(validRequestId(a)).toBe(true);
    expect(validRequestId('x')).toBe(false);
    expect(validRequestId('bad id with spaces')).toBe(false);
  });
  it('describeTrace shows id, call status, timings, the turn summary and failure; never a key', () => {
    const line = describeTrace(client());
    expect(line).toContain('rq-abc-1'); expect(line).toContain('model called (deepseek-chat, HTTP 200)'); expect(line).toContain('model 700 ms (first byte 120 ms)'); expect(line).toContain('round trip 720 ms'); expect(line).toContain('discuss');
    const two = server({ calls: [{ stage: 'plan', modelCalled: true, httpStatus: 200, ttfbMs: 1, modelMs: 500, budgetReservation: 1, failure: null }, { stage: 'compose', modelCalled: true, httpStatus: 200, ttfbMs: 1, modelMs: 800, budgetReservation: 2, failure: null }], turn: { mode: 'what_if', tools: ['quote_plans'], ui: ['compare'], guardOk: false, answerReplaced: true, ignoredChanges: true, changeKeys: [] } });
    const l2 = describeTrace(client({ server: two }));
    expect(l2).toContain('2 calls: plan 500 ms, compose 800 ms'); expect(l2).toContain('what_if · tools quote_plans · ui compare · wording replaced by guard · state changes ignored');
    expect(describeTrace(client({ route: 'rules_only', server: null, outcome: 'rules', roundTripMs: 0 }))).toContain('model NOT called');
    expect(describeTrace(client({ server: server({ modelCalled: false, model: null, httpStatus: null, ttfbMs: null, modelMs: null }), outcome: 'model_failed', failure: 'stub-fail' }))).toContain('model NOT called');
    expect(describeTrace(client({ server: null, outcome: 'model_failed', failure: 'network_error: x' }))).toContain('server not reached');
  });
});
