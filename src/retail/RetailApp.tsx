import { useEffect, useRef, useState } from 'react';
import { AddressCard, ChangeCard, CompareCard, ConfirmCard, DeadlineCard, DropDateCard, OrdersCard, PickupCard, PlansCard, ProgressCard, ReceiptCard, ServicePointsCard, SymptomsCard, TermsCard, type CardApi } from './cards.tsx';
import { RETAIL_TODAY, SCENARIOS, SERVICE_POINTS, scenarioById, type ScenarioId } from './data.ts';
import { applyIntent, type Reply } from './flow.ts';
import { parseIntentLocal, type Intent } from './intent.ts';
import { checkResponse, describeTrace, newRequestId, viaLabel, type ClientTrace } from './trace.ts';
import { cardLive, candidateOrders, confirmKey, initialTask, isLocked, ASKING, markAnswered, nextNeed, nextRid, payloadOf, plansKey, reportOf, revisionOf, setPlan, type Card, type CardType, type QuickReply, type RMsg, type TaskState } from './state.ts';
import type { SubmitResult } from './service.ts';
import { diffTask } from './state.ts';
import type { HistoryItem, QueryResult, UiItem } from './turn.ts';
import type { TurnResponse } from './trace.ts';
import { LangMessage } from './openui/LangMessage.tsx';
import { eventToIntent, type UiEvent } from './openui/events.ts';

const SAMPLE = 'My headphones are broken and I need them for a business trip next week. Please help.';
const welcome = (): RMsg => ({ id: nextRid('w'), role: 'agent', text: 'Hi, I can handle your after-sales request step by step, right here in the chat. Just tell me what happened, for example: "My headphones are broken and I need them for a business trip next week." I will ask only for what I am missing. Orders, policies, costs and dates come from synthetic demo data and a simulated service.' });
const VIA: Record<'model' | 'rules_only' | 'rules_chosen' | 'failed' | 'pending' | 'action', string> = {
  model: 'Understood by model', rules_only: 'Understood by rules (rules-only mode, no model call)',
  rules_chosen: 'Understood by rules (you chose rules after the model failed)', failed: 'Model call failed, nothing was understood',
  pending: 'Asking the model…', action: 'Quick action (direct, no model)',
};
const REASK: Partial<Record<CardType, string>> = { orders: 'Sure, which item?', symptoms: 'Sure, what is wrong with it?', deadline: 'Sure, what is the latest day you need it?', plans: 'Sure, here are the options again.',
  pickup: 'Sure, when should the courier come?', dropdate: 'Sure, which day will you drop it off?', servicepoints: 'Sure, pick a service point.' };

const liveTypes = (msgs: RMsg[], t: TaskState): CardType[] => msgs.flatMap((m, i) => (m.role === 'agent' && m.card && cardLive(msgs, i, t) ? [m.card.type] : []));

export function RetailApp() {
  const [scenarioId, setScenarioId] = useState<ScenarioId>('standard');
  const [task, setTask] = useState<TaskState>(() => initialTask(scenarioById('standard')));
  const [msgs, setMsgs] = useState<RMsg[]>(() => [welcome()]);
  const [loading, setLoading] = useState(false);
  const [question, setQuestion] = useState('');
  const [calcing, setCalcing] = useState(false);
  const [interpreter, setInterpreter] = useState<'model' | 'rules'>('model');   // chosen by the user, shown in the header; never switched silently
  const [uiMode, setUiMode] = useState<'openui' | 'cards'>('openui');   // chosen by the user, shown in the header: model-written interface (OpenUI Lang) or the fixed v0.4 cards
  const [traces, setTraces] = useState<ClientTrace[]>([]);
  const [traceOpen, setTraceOpen] = useState(false);
  const taskRef = useRef(task); const msgsRef = useRef(msgs);
  const session = useRef(`rs-${Math.random().toString(36).slice(2, 8)}`);
  const inflight = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [msgs.length, loading]);

  // "recalculating": any change to a quote input must finish before submit is enabled
  const calcKey = `${plansKey(task)}|${confirmKey(task)}`;
  useEffect(() => { setCalcing(true); const id = setTimeout(() => setCalcing(false), 300); return () => clearTimeout(id); }, [calcKey]);

  const setT = (n: TaskState) => { taskRef.current = n; setTask(n); };
  const commit = (next: RMsg[]) => { msgsRef.current = next; setMsgs(next); }; // the ref is the source of truth between renders
  const push = (...m: RMsg[]) => commit([...msgsRef.current, ...m]);
  const agentMsgs = (replies: Reply[], t: TaskState): RMsg[] => replies.map((r) => ({
    id: nextRid('a'), role: 'agent' as const, text: r.text, card: r.card ? { type: r.card.type, mode: r.card.mode, data: r.card.data, ids: r.card.ids, snapshot: t, idemKey: r.card.type === 'confirm' ? `${session.current}:${nextRid('k')}` : undefined } : undefined, quick: r.quick,
  }));
  /** One turn: merge into the task, collapse cards that are now answered, then ask the single next thing. */
  function step(base: TaskState, intent: Intent, answered = false, opts: { diff?: boolean; lead?: string; ui?: Reply[] } = {}) {
    const marked = markAnswered(msgsRef.current, base);
    const r = applyIntent(base, intent, { live: (nt) => liveTypes(markAnswered(marked, nt), nt), answered });
    setT(r.task);
    const lead: RMsg[] = opts.lead ? [{ id: nextRid('a'), role: 'agent', text: opts.lead }] : [];
    const d = opts.diff ? diffTask(base, r.task) : null;
    const diffMsg: RMsg[] = d && d.changed.length ? [{ id: nextRid('a'), role: 'agent', text: `Changed: ${d.changed.map((c) => `${c.label}: ${c.from} → ${c.to}`).join('; ')}.\nUnchanged: ${d.kept.join(', ') || 'nothing else was set'}.` }] : d ? [{ id: nextRid('a'), role: 'agent', text: 'Nothing changed: that was already the case.' }] : [];
    commit([...markAnswered(marked, r.task), ...lead, ...diffMsg, ...agentMsgs(r.replies, r.task), ...agentMsgs(opts.ui ?? [], r.task)]);   // say what changed first, then ask what is next
  }
  const run = (intent: Intent, answered = false, opts: { diff?: boolean } = {}) => step(taskRef.current, intent, answered, opts);

  /** What the model sees of the conversation so far: recent wording plus the app's own summary of any what-if (so "use the one we just compared" resolves). */
  const historyOf = (excludeId?: string): HistoryItem[] => msgsRef.current.flatMap((m): HistoryItem[] => (m.role === 'user' ? (m.id === excludeId ? [] : [{ role: 'user', text: m.text }]) : m.role === 'agent' && !m.error && (m.text || m.memo || m.lang) ? [{ role: 'agent', text: m.text || m.lang?.payload.summary || '', memo: m.memo }] : [])).slice(-12);
  const uiReplies = (ui: UiItem[], results: QueryResult[]): Reply[] => ui.flatMap((u): Reply[] => {
    if (u.component === 'compare') { const r = results.find((x) => x.id === u.query); return r ? [{ text: '', card: { type: 'compare', data: r } }] : []; }
    if (u.component === 'servicepoints') return [{ text: '', card: { type: 'servicepoints', ids: u.ids } }];
    if (u.component === 'address') return [{ text: '', card: { type: 'address', mode: 'edit' } }];
    return [{ text: '', card: { type: u.component } }];
  });
  /** Apply the model's plan. discuss / what_if never touch the task; change goes through the same deterministic path as buttons. */
  function applyTurn(turn: TurnResponse) {
    if (turn.lang) { applyLangTurn(turn); return; }
    const plan = turn.plan; const results = turn.results as QueryResult[];
    const ui = uiReplies(plan.ui, results);
    const note = turn.guard.replaced ? '\n(The application wrote this from its own figures: the model\'s wording contained a figure the application had not computed.)' : '';
    if (plan.mode === 'change') { step(taskRef.current, plan.changes, false, { diff: true, lead: plan.answer ? plan.answer + note : undefined, ui }); return; }
    const quick: QuickReply[] = plan.quick.map((q) => ({ text: q.text, intent: q.changes, diff: true }));
    const first: RMsg = { id: nextRid('a'), role: 'agent', text: plan.answer + note, quick: quick.length ? quick : undefined, memo: turn.memo || undefined };
    commit([...msgsRef.current, first, ...agentMsgs(ui, taskRef.current)]);
  }

  /**
   * A turn whose interface was written by the model (OpenUI Lang). The application applies any state change itself (same pure
   * function the server used to show the model the new state), says what changed, then shows the validated program. If the
   * program was rejected the user is told so and the fixed card for the pending question is shown instead (never silently).
   */
  function applyLangTurn(turn: TurnResponse, afterEvent?: { before: TaskState }) {
    const lang = turn.lang!; const requestId = turn.trace.requestId;
    const base = afterEvent?.before ?? taskRef.current;
    let task = taskRef.current; let head: RMsg[] = [];
    if (!afterEvent && turn.plan.mode === 'change') {
      const marked = markAnswered(msgsRef.current, base);
      const r = applyIntent(base, turn.plan.changes, { noAsk: true, answered: false });
      task = r.task; setT(task); commit(markAnswered(marked, task));
      const report = reportOf(base, task);
      const notesTxt = r.replies.map((x) => x.text).filter(Boolean).join('\n');
      head = [...(report ? [{ id: nextRid('a'), role: 'agent' as const, text: report }] : []), ...(notesTxt ? [{ id: nextRid('a'), role: 'agent' as const, text: notesTxt }] : []), ...agentMsgs(r.replies.filter((x) => x.card), task)];   // what changed first, then the application's notes
    }   // after a pressed control the application already said what changed (uiEvent), so nothing is repeated here
    const memo = turn.memo || undefined;
    if (lang.ok) {
      const lm: RMsg = { id: nextRid('a'), role: 'agent', text: '', memo, lang: { payload: lang, snapshot: task, requestId } };
      const confirm = lang.need === 'confirm' && !isLocked(task) ? agentMsgs([{ text: 'Here is the full summary. Nothing is submitted until you press Confirm and submit.', card: { type: 'confirm' } }], task) : [];
      commit([...msgsRef.current, ...head, lm, ...confirm]);
    } else {
      const why = lang.errors.slice(0, 2).join(' | ');
      const note: RMsg = { id: nextRid('a'), role: 'agent', error: true, lang: { payload: lang, snapshot: task, requestId }, text: `The interface the model wrote was rejected by the application's checks (${why || 'invalid'}), so it was not shown.${turn.plan.answer ? `\n${turn.plan.answer}` : ''} Showing the standard question instead.` };
      commit([...msgsRef.current, ...head, note]);
      const live2 = (nt: TaskState) => liveTypes(markAnswered(msgsRef.current, nt), nt);
      const r = applyIntent(task, {}, { live: live2, answered: true });
      setT(r.task); commit([...markAnswered(msgsRef.current, r.task), ...agentMsgs(r.replies, r.task)]);
    }
  }

  /** A control inside a model-written interface was used: check it, apply it as an Intent, then let the model compose what comes next. */
  async function uiEvent(msgId: string, ev: UiEvent, label: string) {
    const m = msgsRef.current.find((x) => x.id === msgId);
    const t = taskRef.current;
    if (!m || m.role !== 'agent' || !m.lang || loading || inflight.current) return;
    const stale = revisionOf(t) !== m.lang.payload.stateRevision || isLocked(t);
    if (stale) { push({ id: nextRid('a'), role: 'agent', error: true, text: 'Those options were out of date, so nothing was changed.' }); return; }
    const chk = eventToIntent(ev, m.lang.payload.controls, m.lang.payload.bundle);
    if (!chk.ok) { push({ id: nextRid('a'), role: 'agent', error: true, text: `That choice was not valid (${chk.reason}). Nothing was changed.` }); return; }
    if (ev.kind === 'ask') { await ask(ev.text); return; }
    const userId = nextRid('u');
    push({ id: userId, role: 'user', text: label || chk.label, via: 'action', from: undefined });
    const before = taskRef.current;
    const marked = markAnswered(msgsRef.current, before);
    const r = applyIntent(before, chk.intent, { noAsk: true, answered: true });
    setT(r.task); commit(markAnswered(marked, r.task));
    const report = reportOf(before, r.task);
    const notes = r.replies.map((x) => x.text).filter(Boolean).join('\n');
    if (report) push({ id: nextRid('a'), role: 'agent', text: report });
    if (notes) push({ id: nextRid('a'), role: 'agent', text: notes });
    push(...agentMsgs(r.replies.filter((x) => x.card), r.task));
    const need = nextNeed(r.task);
    if (isLocked(r.task) || need === null) return;
    if (need === 'confirm') { push(...agentMsgs([{ text: 'Here is the full summary. Nothing is submitted until you press Confirm and submit.', card: { type: 'confirm' } }], r.task)); return; }
    await requestUi(`The user chose: ${label || chk.label}`, { report, notes }, userId);
  }
  /** Ask the server for the interface that follows an applied control (one model call, no planning step). */
  async function requestUi(text: string, event: { report: string | null; notes: string }, userId: string) {
    const requestId = newRequestId(); const sentAt = new Date().toISOString(); const t0 = performance.now();
    setLoading(true); inflight.current = true;
    try {
      let json: unknown = null, netFailure: string | null = null;
      try {
        const res = await fetch('/api/retail/interpret', { method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': requestId }, body: JSON.stringify({ message: text, history: historyOf(userId), task: { ...taskRef.current, submit: { status: taskRef.current.submit.status } }, requestId, ui: 'openui', event }) });
        json = await res.json();
      } catch (e) { netFailure = `network_error: ${(e as Error).message}`; }
      const roundTripMs = Math.round(performance.now() - t0);
      const checked = netFailure ? { ok: false as const, reason: netFailure, trace: null } : checkResponse(json, requestId);
      if (checked.ok) {
        const trace: ClientTrace = { requestId, route: 'model', sentAt, roundTripMs, server: checked.turn.trace, outcome: 'model_ok', failure: null, retryOf: null };
        addTrace(trace); patchUser(userId, 'action', trace);
        applyLangTurn(checked.turn, { before: taskRef.current });
      } else {
        const trace: ClientTrace = { requestId, route: 'model', sentAt, roundTripMs, server: checked.trace, outcome: 'model_failed', failure: checked.reason, retryOf: null };
        addTrace(trace); patchUser(userId, 'action', trace);
        push({ id: nextRid('a'), role: 'agent', error: true, text: `I could not get the model to write the next step (${checked.reason}). Your choice was applied; showing the standard question instead.` });
        const live2 = (nt: TaskState) => liveTypes(markAnswered(msgsRef.current, nt), nt);
        const r = applyIntent(taskRef.current, {}, { live: live2, answered: true });
        setT(r.task); commit([...markAnswered(msgsRef.current, r.task), ...agentMsgs(r.replies, r.task)]);
      }
    } finally { setLoading(false); inflight.current = false; }
  }

  const parseCtx = () => {
    const t = taskRef.current; const need = nextNeed(t);
    return { orders: candidateOrders(t), expect: need === 'order' ? 'order' as const : need === 'servicepoint' || need === 'location' ? 'servicepoint' as const : need === 'deadline' ? 'deadline' as const : need === 'dropdate' || need === 'pickup' ? 'pickupdate' as const : undefined };
  };
  const patchUser = (id: string, via: Extract<RMsg, { role: 'user' }>['via'], trace: ClientTrace) => commit(msgsRef.current.map((m) => (m.id === id && m.role === 'user' ? { ...m, via, trace } : m)));
  const addTrace = (t: ClientTrace) => setTraces((x) => [...x, t]);

  /**
   * One natural-language turn. Default: the MODEL reads the message together with the task state. Rules are used only when the
   * user selected "Rules only" or explicitly chose them after a model failure. A model failure never silently falls back.
   */
  async function ask(text: string, opts: { msgId?: string; retryOf?: string } = {}) {
    const requestId = newRequestId();
    const sentAt = new Date().toISOString();
    const id = opts.msgId ?? nextRid('u');
    const mode = interpreter;
    if (!opts.msgId) push({ id, role: 'user', text, via: mode === 'rules' ? 'rules_only' : 'pending' });
    else commit(msgsRef.current.map((m) => (m.id === id && m.role === 'user' ? { ...m, via: 'pending' as const, trace: undefined } : m)));
    setLoading(true);
    const t0 = performance.now();
    try {
      if (mode === 'rules') {
        const trace: ClientTrace = { requestId, route: 'rules_only', sentAt, roundTripMs: 0, server: null, outcome: 'rules', failure: null, retryOf: opts.retryOf ?? null };
        addTrace(trace); patchUser(id, 'rules_only', trace);
        run(parseIntentLocal(text, parseCtx()));
        return;
      }
      let json: unknown = null, netFailure: string | null = null;
      try {
        const sendTask = { ...taskRef.current, submit: { status: taskRef.current.submit.status } };
        const res = await fetch('/api/retail/interpret', { method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': requestId }, body: JSON.stringify({ message: text, history: historyOf(id), task: sendTask, requestId, ui: uiMode }) });
        json = await res.json();
      } catch (e) { netFailure = `network_error: ${(e as Error).message}`; }
      const roundTripMs = Math.round(performance.now() - t0);
      const checked = netFailure ? { ok: false as const, reason: netFailure, trace: null } : checkResponse(json, requestId);
      if (checked.ok) {
        const trace: ClientTrace = { requestId, route: 'model', sentAt, roundTripMs, server: checked.turn.trace, outcome: checked.turn.trace.outcome === 'ok_nothing_actionable' ? 'model_ok_nothing_actionable' : 'model_ok', failure: null, retryOf: opts.retryOf ?? null };
        addTrace(trace); patchUser(id, viaLabel(trace), trace);
        applyTurn(checked.turn);
      } else {
        const trace: ClientTrace = { requestId, route: 'model', sentAt, roundTripMs, server: checked.trace, outcome: 'model_failed', failure: checked.reason, retryOf: opts.retryOf ?? null };
        addTrace(trace); patchUser(id, 'failed', trace);
        push({ id: nextRid('a'), role: 'agent', error: true,
          text: `I could not get the model to read that message (${checked.reason}). Nothing was changed. You can retry, or choose to have the basic rules read it instead.`,
          quick: [{ text: 'Retry with the model', action: 'retry', payload: { msgId: id, text, requestId } }, { text: 'Use basic rules for this message', action: 'use_rules', payload: { msgId: id, text, requestId } }] });
      }
    } finally { setLoading(false); }
  }
  /** Explicit user choice after a model failure: the rules read this one message, labelled as such. */
  function useRulesFor(p: { msgId: string; text: string; requestId: string }) {
    const trace: ClientTrace = { requestId: newRequestId(), route: 'rules_chosen', sentAt: new Date().toISOString(), roundTripMs: 0, server: null, outcome: 'rules', failure: null, retryOf: p.requestId };
    addTrace(trace); patchUser(p.msgId, 'rules_chosen', trace);
    run(parseIntentLocal(p.text, parseCtx()));
  }

  const api: CardApi = {
    update: (fn) => setT(fn(taskRef.current)),
    answer: (text, fn, from) => { push({ id: nextRid('u'), role: 'user', text, via: 'action', from }); step(fn(taskRef.current), {}, true); },
    quick: (text, intent) => { push({ id: nextRid('u'), role: 'user', text, via: 'action' }); run(intent); },
    apply: (text, intent) => { push({ id: nextRid('u'), role: 'user', text, via: 'action' }); run(intent, false, { diff: true }); },
    say: (userText, agentText) => push({ id: nextRid('u'), role: 'user', text: userText, via: 'action' }, { id: nextRid('a'), role: 'agent', text: agentText }),
    reask: (type) => push({ id: nextRid('a'), role: 'agent', text: REASK[type] ?? '', card: { type, snapshot: taskRef.current } }),
    submit: async (card) => {
      const t = taskRef.current;
      const payload = payloadOf(t);
      if (inflight.current || isLocked(t) || !payload || confirmKey(card.snapshot) !== confirmKey(t)) return; // double click / stale card: nothing is sent
      inflight.current = true;
      setT({ ...t, submit: { status: 'submitting' } });
      try {
        const res = await fetch('/api/retail/submit', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: card.idemKey, scenario: scenarioId, payload, confirmed: true }) });
        const r = (await res.json()) as SubmitResult;
        if (r.ok) {
          const done: TaskState = { ...taskRef.current, submit: { status: 'done', record: r.record } };
          setT(done);
          push({ id: nextRid('a'), role: 'agent', text: r.duplicate ? 'This request was already created; here is the same receipt (no duplicate was made).' : 'Submitted. This receipt was returned by the simulated service.', card: { type: 'receipt', snapshot: done, record: r.record } });
        } else setT({ ...taskRef.current, submit: { status: 'failed', message: r.message, created: r.created } });
      } catch (e) {
        setT({ ...taskRef.current, submit: { status: 'failed', message: `Network error (${(e as Error).message}).`, created: 'unknown' } });
      } finally { inflight.current = false; }
    },
    progress: async (id) => {
      push({ id: nextRid('u'), role: 'user', text: 'View progress', via: 'action' });
      try {
        const r = await (await fetch(`/api/retail/progress?id=${encodeURIComponent(id)}`)).json() as { ok: boolean; lines?: string[]; message?: string };
        push({ id: nextRid('a'), role: 'agent', text: r.ok ? '' : r.message ?? 'Could not load progress.', card: r.ok ? { type: 'progress', snapshot: taskRef.current, progress: r.lines } : undefined });
      } catch { push({ id: nextRid('a'), role: 'agent', text: 'Progress is unavailable right now. Please try again later.', error: true }); }
    },
  };

  const quickReply = (q: QuickReply) => {
    if (q.action === 'progress') { const t = taskRef.current; if (t.submit.status === 'done') api.progress(t.submit.record.id); }
    else if (q.action === 'replan') api.answer('Choose another plan', (t) => setPlan(t, null));
    else if (q.action === 'retry' && q.payload) ask(q.payload.text, { msgId: q.payload.msgId, retryOf: q.payload.requestId });
    else if (q.action === 'use_rules' && q.payload) useRulesFor(q.payload);
    else if (q.diff) api.apply(q.text, q.intent ?? {});
    else api.quick(q.text, q.intent ?? {});
  };
  const changeScenario = (id: ScenarioId) => { setTraces([]); setScenarioId(id); setT(initialTask(scenarioById(id))); commit([welcome()]); session.current = `rs-${Math.random().toString(36).slice(2, 8)}`; };

  return (
    <div className="app rt-app" data-testid="retail-app">
      <header className="top">
        <h1>After-sales service</h1>
        <span className="badge demo" data-testid="rt-demo-badge">Demo environment · synthetic data · no real refund, shipment or booking · reference date {RETAIL_TODAY}</span>
        <label className="rt-scn">Understand messages with
          <select data-testid="rt-interpreter" value={interpreter} onChange={(e) => setInterpreter(e.target.value as 'model' | 'rules')}>
            <option value="model">Model (default)</option><option value="rules">Rules only (no model calls)</option></select></label>
        <label className="rt-scn">Interface
          <select data-testid="rt-ui-mode" value={uiMode} onChange={(e) => setUiMode(e.target.value as 'openui' | 'cards')}>
            <option value="openui">Model-written (OpenUI)</option><option value="cards">Fixed cards (v0.4)</option></select></label>
        <button type="button" data-testid="rt-trace-toggle" onClick={() => setTraceOpen((o) => !o)}>Trace ({traces.length})</button>
        <label className="rt-scn">Demo scenario
          <select data-testid="rt-scenario" value={scenarioId} onChange={(e) => changeScenario(e.target.value as ScenarioId)}>{SCENARIOS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
      </header>
      {traceOpen && (
        <section className="rt-trace" data-testid="rt-trace-panel" aria-label="Natural-language trace">
          <b>Every typed message: browser Send → /api/retail/interpret → model.</b> <span className="muted">No key, prompt or message text is recorded; server copy: GET /api/retail/trace</span>
          {traces.length === 0 ? <p className="muted">No messages yet.</p> : <ol>{traces.map((t) => <li key={t.requestId} data-testid="rt-trace-row">{t.route} · {t.outcome} · {describeTrace(t)}{t.retryOf ? ` · retry of ${t.retryOf}` : ''}</li>)}</ol>}
        </section>
      )}
      <main className="stream" data-testid="rt-messages" aria-busy={loading}>
        {msgs.map((m, i) => {
          if (m.role === 'user') return <div key={m.id} className={`msg user${m.via === 'failed' ? ' failed' : ''}`} data-testid="rt-user-msg">{m.text}<div className="rt-via" data-testid="rt-via">{VIA[m.via]}</div>{m.trace && <div className="rt-trace-line" data-testid="rt-trace-line">{describeTrace(m.trace)}</div>}</div>;
          if (m.role === 'action') return <div key={m.id} className="msg action" data-testid="rt-action-msg">{m.text}</div>;
          if (m.lang) {
            const live = m.lang.payload.ok && revisionOf(task) === m.lang.payload.stateRevision && !isLocked(task) && !loading;
            return <section key={m.id} className="msg agent" data-testid="rt-agent-msg">{m.text && <p className="rt-text" data-testid="rt-agent-text">{m.text}</p>}<LangMessage lang={m.lang.payload} state={live ? task : m.lang.snapshot} live={live} requestId={m.lang.requestId} onEvent={(ev, label) => { void uiEvent(m.id, ev, label); }} />{m.quick && <div className="prepared rt-quick">{m.quick.map((q) => <button key={q.text} type="button" onClick={() => quickReply(q)}>{q.text}</button>)}</div>}</section>;
          }
          const card = m.card;
          const live = card ? cardLive(msgs, i, task) : false;
          // answered cards read the current task; an outdated confirmation stays frozen as it was shown
          const view = !card || live ? task : card.type === 'confirm' ? card.snapshot : task;   // the old plan comparison is rebuilt from its own snapshot inside PlansCard
          const p = { card: card as Card, view, current: task, live, answered: !!m.answered, busy: calcing, api, locked: isLocked(task) };
          // a question that was asked again leaves only its newest card; older answered copies would just repeat the same line
          const superseded = !!card && ASKING.includes(card.type) && msgs.slice(i + 1).some((x) => x.role === 'agent' && x.card?.type === card.type);
          if (superseded && !live && !m.text) return null;
          const collapsedOnly = card && !live && m.text === '';
          return (
            <section key={m.id} className={`msg agent${collapsedOnly ? ' compact' : ''}`} data-testid="rt-agent-msg">
              {m.text && <p className="rt-text" data-testid="rt-agent-text">{m.text}</p>}
              {!(superseded && !live) && <>
              {card?.type === 'orders' && <OrdersCard {...p} />}
              {card?.type === 'symptoms' && <SymptomsCard {...p} />}
              {card?.type === 'deadline' && <DeadlineCard {...p} />}
              {card?.type === 'plans' && <PlansCard {...p} />}
              {card?.type === 'address' && <AddressCard {...p} />}
              {card?.type === 'pickup' && <PickupCard {...p} />}
              {card?.type === 'servicepoints' && <ServicePointsCard {...p} />}
              {card?.type === 'dropdate' && <DropDateCard {...p} />}
              {card?.type === 'compare' && <CompareCard {...p} />}
              </>}
              {card?.type === 'confirm' && <ConfirmCard {...p} />}
              {card?.type === 'receipt' && <ReceiptCard {...p} />}
              {card?.type === 'terms' && <TermsCard />}
              {card?.type === 'progress' && <ProgressCard {...p} />}
              {card?.type === 'change' && <ChangeCard {...p} />}
              {m.quick && <div className="prepared rt-quick">{m.quick.map((q) => <button key={q.text} type="button" onClick={() => quickReply(q)}>{q.text}</button>)}</div>}
            </section>
          );
        })}
        {loading && <div className="msg agent loading" data-testid="rt-loading">Understanding…</div>}
        <div ref={endRef} />
      </main>
      <footer className="composer">
        <div className="composer-card">
          <div className="prepared"><button type="button" data-testid="rt-sample" onClick={() => ask(SAMPLE)} disabled={loading}>Example: {SAMPLE}</button></div>
          <form onSubmit={(e) => { e.preventDefault(); if (question.trim() && !loading) { ask(question.trim()); setQuestion(''); } }}>
            <input type="text" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Tell me what you need, e.g. ship it to my company" data-testid="rt-question" />
            <button className="primary" disabled={loading} data-testid="rt-ask">Send</button>
          </form>
        </div>
      </footer>
    </div>
  );
}

