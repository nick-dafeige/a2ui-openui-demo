import { useEffect, useRef, useState } from 'react';
import { generateCalls } from './data/generate.ts';
import { CAMPAIGNS, REFERENCE } from './data/spec.ts';
import type { Layout } from './layout/components.ts';
import { loadLayout, saveLayout } from './layout/parse.ts';
import { PREPARED } from './ai/prepared.ts';
import type { PlanOutcome, PlanSource } from './ai/planner.ts';
import type { AnalysisRequest } from './query/validate.ts';
import { campaignName } from './report/model.ts';
import { ReportMessage } from './chat/ReportMessage.tsx';
import { drillReport, latestReport, nextId, patchReport, reportFromRequest, selectedCampaign, type Msg, type ReportInstance } from './chat/state.ts';

const CALLS = generateCalls();
const PREPARED_LABEL: Record<keyof typeof PREPARED, string> = { overview: 'Campaign overview', change: 'Answer-rate change', drilldown_c2: 'Unanswered calls: Payment Reminder' };
const WELCOME: Msg = { id: 'welcome', role: 'agent', text: 'Ask about your campaigns, e.g. "How did each campaign do last week?". Every answer arrives here with its own report. All data is synthetic demo data.' };

export function App() {
  const [msgs, setMsgs] = useState<Msg[]>([WELCOME]);
  const [pref, setPref] = useState<Layout>(() => loadLayout()); // preference for FUTURE reports only
  const [prefSaved, setPrefSaved] = useState(true);
  const [loading, setLoading] = useState(false);
  const [question, setQuestion] = useState('');
  const msgsRef = useRef(msgs); msgsRef.current = msgs;
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [msgs.length, loading]);

  const add = (...m: Msg[]) => setMsgs((x) => [...x, ...m]);
  const agentReport = (report: ReportInstance): Msg => ({ id: nextId('m'), role: 'agent', text: '', report });
  const withoutErrors = (x: Msg[]) => x.filter((m) => !(m.role === 'agent' && m.error));

  function plan(req: AnalysisRequest, src: PlanSource) {
    const r = reportFromRequest(req, src, latestReport(msgsRef.current), pref);
    setMsgs((x) => [...withoutErrors(x), agentReport(r)]);
  }
  function handle(o: PlanOutcome, q: string) {
    if (o.kind === 'plan') plan(o.request, o.source);
    else if (o.kind === 'unknown_metric') add({ id: nextId('m'), role: 'agent', text: `That metric is not available. Available metrics: ${o.available.join(', ')}. Try one of these, e.g. "answer rate last week". Earlier reports are unchanged.` });
    else if (o.kind === 'need_campaign') add({ id: nextId('m'), role: 'agent', text: 'Which campaign do you mean? Pick one:', choose: true });
    else add({ id: nextId('m'), role: 'agent', text: `The model response failed (${o.reason}). Earlier reports are unchanged.`, error: { reason: o.reason, question: q } });
  }
  async function ask(q: string) {
    add({ id: nextId('u'), role: 'user', text: q });
    setLoading(true);
    try {
      const res = await fetch('/api/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q, selectedCampaignId: selectedCampaign(msgsRef.current) }) });
      handle((await res.json()) as PlanOutcome, q);
    } catch (e) { handle({ kind: 'failed', reason: `network_error: ${(e as Error).message}` }, q); }
    finally { setLoading(false); }
  }
  const usePrepared = (k: keyof typeof PREPARED) => {
    add({ id: nextId('a'), role: 'action', text: `Prepared analysis (no model call): ${PREPARED_LABEL[k]}` });
    plan(PREPARED[k], 'fallback');
  };
  function drill(from: ReportInstance, campaignId: string) {
    add({ id: nextId('a'), role: 'action', text: `Action: View unanswered calls · ${campaignName(campaignId)} · ${from.filters.range.start} to ${from.filters.range.end}` },
      agentReport(drillReport(from, campaignId, pref)));
  }
  function savePref(l: Layout) {
    setPref(l); setPrefSaved(saveLayout(l));
    add({ id: nextId('a'), role: 'action', text: 'Layout saved as preference for future reports. Existing reports keep their own layout.' });
  }
  function applyLayout(reportId: string, l: Layout, save: boolean) {
    setMsgs((x) => patchReport(x, reportId, (r) => ({ ...r, layout: l, editing: false })));
    if (save) savePref(l);
  }

  return (
    <div className="app">
      <header className="top">
        <h1>Scene</h1>
        <span className="badge demo" data-testid="demo-badge">DEMO DATA · synthetic · ref. {REFERENCE.referenceDate} {REFERENCE.timeZone}</span>
        {!prefSaved && <span className="badge error" data-testid="save-warning">Browser blocked storage: layout preference will not survive a refresh.</span>}
      </header>
      <main className="stream" data-testid="messages" aria-busy={loading}>
        {msgs.map((m) => m.role === 'agent' ? (
          <section key={m.id} className="msg agent" data-testid="agent-msg">
            {m.report ? <ReportMessage report={m.report} calls={CALLS}
                update={(fn) => setMsgs((x) => patchReport(x, m.report!.id, fn))}
                drill={(id) => drill(m.report!, id)}
                applyLayout={(l, save) => applyLayout(m.report!.id, l, save)}
                savePreference={() => savePref(m.report!.layout)} />
              : <p>{m.text}</p>}
            {m.choose && <div className="prepared">{CAMPAIGNS.map((c) => <button key={c.id} onClick={() => ask(`Show unanswered calls for ${c.name}`)}>{c.name}</button>)}</div>}
            {m.error && <div className="banner error" role="alert" data-testid="error-banner">
              <div className="prepared"><button onClick={() => ask(m.error!.question)} data-testid="retry">Retry</button>
                {(Object.keys(PREPARED) as (keyof typeof PREPARED)[]).map((k) => <button key={k} onClick={() => usePrepared(k)}>Prepared: {PREPARED_LABEL[k]}</button>)}</div></div>}
          </section>
        ) : (<div key={m.id} className={`msg ${m.role}`} data-testid={m.role === 'user' ? 'user-msg' : 'action-msg'}>{m.text}</div>))}
        {loading && <div className="msg agent loading" data-testid="loading">Analysing…</div>}
        <div ref={endRef} />
      </main>
      <footer className="composer">
        <div className="composer-card">
        <div className="prepared" aria-label="Prepared analyses">{(Object.keys(PREPARED) as (keyof typeof PREPARED)[]).map((k) => <button key={k} onClick={() => usePrepared(k)} data-testid={`prepared-${k}`}>{PREPARED_LABEL[k]}</button>)}<span className="muted">prepared · no model call</span></div>
        <form onSubmit={(e) => { e.preventDefault(); if (question.trim() && !loading) { ask(question.trim()); setQuestion(''); } }}>
          <input type="text" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask a question…" data-testid="question" />
          <button className="primary" disabled={loading} data-testid="ask">Ask</button>
        </form>
        </div>
      </footer>
    </div>
  );
}
