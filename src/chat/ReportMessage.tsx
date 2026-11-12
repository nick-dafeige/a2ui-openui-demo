import { useMemo } from 'react';
import { Renderer } from '@openuidev/react-lang';
import type { CallRecord } from '../data/generate.ts';
import { CAMPAIGNS } from '../data/spec.ts';
import { arrange } from '../layout/arrange.ts';
import type { Layout } from '../layout/components.ts';
import { EnvContext, library, programFor, unknownComponents } from '../report/library.tsx';
import { buildReport, campaignName, type DrillSpec, type Filters } from '../report/model.ts';
import { CallDetail } from '../CallDetail.tsx';
import { EditLayout } from '../EditLayout.tsx';
import { basis, headline, narrative } from './narrative.ts';
import type { ReportInstance, ReportSource } from './state.ts';

const SOURCE_LABEL: Record<ReportSource, string> = { live: 'Live model response', fallback: 'Prepared fallback analysis', action: 'Direct action · no model call' };
const same = (a: Filters, b: Filters) => JSON.stringify(a) === JSON.stringify(b);

export interface ReportMessageProps {
  report: ReportInstance; calls: CallRecord[];
  update: (fn: (r: ReportInstance) => ReportInstance) => void;
  drill: (campaignId: string) => void;
  applyLayout: (l: Layout, saveAsPreference: boolean) => void;
  savePreference: () => void;
}

/** One Agent reply: text, scope, and the OpenUI report. All report state lives in `report`, owned by this message. */
export function ReportMessage({ report, calls, update, drill, applyLayout, savePreference }: ReportMessageProps) {
  const { spec, filters, layout } = report;
  const data = useMemo(() => buildReport(calls, spec, filters), [calls, spec, filters]);
  const program = useMemo(() => programFor(arrange(layout, spec.components)), [layout, spec.components]);
  const bad = unknownComponents(program);
  const call = report.openCallId ? calls.find((c) => c.id === report.openCallId) ?? null : null;
  const setFilters = (f: Filters) => update((r) => ({ ...r, filters: f, openCallId: null, spec: r.spec.drill ? { ...r.spec, drill: { ...r.spec.drill, page: 1 } } : r.spec }));
  const toggle = (id: string) => setFilters({ ...filters, campaignIds: filters.campaignIds.includes(id) ? filters.campaignIds.filter((c) => c !== id) : [...filters.campaignIds, id] });
  const names = spec.drill ? campaignName(spec.drill.campaignId) : filters.campaignIds.length === CAMPAIGNS.length ? 'All campaigns' : filters.campaignIds.map(campaignName).join(', ') || 'None selected';
  const worst = data.spec.components.includes('change_ranking') ? headline(data) : undefined;
  const modified = !same(filters, report.askedFilters);
  const text = narrative(calls, data);

  return (
    <div className="report" data-testid="report" data-report-id={report.id}>
      <p className="answer" data-testid="agent-text">{text}</p>
      <div className="scope" data-testid="scope">
        <strong>{report.title}{spec.drill ? ` — ${campaignName(spec.drill.campaignId)}` : ''}</strong>
        <span data-testid="range-label">{filters.range.start} to {filters.range.end}</span>
        <span data-testid="campaigns-label">{names}</span>
        <span className={`badge ${report.source === 'action' ? 'demo' : report.source}`} data-testid="source-badge">{SOURCE_LABEL[report.source]}</span>
        <span className="badge demo">DEMO DATA · synthetic</span>
        {modified && <span className="badge notice" data-testid="modified">filters changed after the question</span>}
      </div>
      <div className="muted" data-testid="basis">{basis(data).join(' · ')}</div>
      {bad.length ? <div className="banner error">Blocked components: {bad.join(', ')}</div>
        : data.empty ? <div className="nodata" data-testid="no-data">No data for these filters.</div>
        : (<EnvContext.Provider value={{ data, layout, onSelectCampaign: drill, onOpenCall: (id) => update((r) => ({ ...r, openCallId: r.openCallId === id ? null : id })),
            onDrill: (p: Partial<Pick<DrillSpec, 'outcome' | 'sort' | 'page'>>) => update((r) => (r.spec.drill ? { ...r, spec: { ...r.spec, drill: { ...r.spec.drill, ...p } } } : r)) }}>
            <Renderer response={program} library={library} /></EnvContext.Provider>)}
      {call && <CallDetail call={call} onClose={() => update((r) => ({ ...r, openCallId: null }))} />}
      <div className="bar actions">
        {worst && <button className="primary" data-testid="drill-action" onClick={() => drill(worst.campaignId)}>View unanswered calls · {campaignName(worst.campaignId)}</button>}
        <details className="inline" data-testid="filters">
          <summary>Filters</summary>
          <div className="filters">
            <label>From <input type="date" value={filters.range.start} onChange={(e) => setFilters({ ...filters, range: { ...filters.range, start: e.target.value } })} data-testid="range-start" /></label>
            <label>To <input type="date" value={filters.range.end} onChange={(e) => setFilters({ ...filters, range: { ...filters.range, end: e.target.value } })} data-testid="range-end" /></label>
            {CAMPAIGNS.map((c) => <label key={c.id}><input type="checkbox" checked={filters.campaignIds.includes(c.id)} onChange={() => toggle(c.id)} data-testid={`filter-${c.id}`} />{c.name}</label>)}
          </div>
        </details>
        <button onClick={() => update((r) => ({ ...r, filters: structuredClone(r.askedFilters), openCallId: null, spec: r.spec.drill ? { ...r.spec, drill: { campaignId: r.spec.drill.campaignId, sort: 'desc', page: 1 } } : r.spec }))} data-testid="clear-filters">Reset to original scope</button>
        <button onClick={() => update((r) => ({ ...r, editing: true }))} data-testid="edit-layout">Edit layout</button>
        <button onClick={savePreference} data-testid="save-pref" title="Use this report's layout for future reports">Save layout as preference</button>
      </div>
      {report.request && (
        <details className="defs" data-testid="provenance"><summary>How this report was made · {report.source === 'live' ? 'model chose the analysis' : 'prepared analysis, no model involved'}</summary>
          <pre data-testid="provenance-request">{JSON.stringify(report.request, null, 2)}</pre>
          <div>The application rejected anything outside the allowed metrics, campaigns and components, computed every figure from the demo data and wrote the text above. The model never supplies numbers.</div></details>)}
      {report.editing && (
        <div className="modal" data-testid="edit-modal">
          <EditLayout current={layout} onApply={(l, save) => { applyLayout(l, save); }} onCancel={() => update((r) => ({ ...r, editing: false }))} />
        </div>)}
    </div>
  );
}
