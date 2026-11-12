import { createContext, useContext, type ReactNode } from 'react';
import { createLibrary, defineComponent } from '@openuidev/react-lang';
import { z } from 'zod/v4';
import { PALETTE, type ComponentId, type Layout } from '../layout/components.ts';
import { campaignName, MIN_SAMPLE, type DrillSpec, type RankMetric, type ReportData } from './model.ts';
import type { Summary } from '../query/metrics.ts';
import { CANNOT_COMPARE, DASH, count, pct, pp } from './format.ts';

/** Runtime data for rendering. Model text never carries figures; they come from here. */
export interface RenderEnv {
  data: ReportData; layout: Layout; onSelectCampaign: (id: string) => void;
  onDrill: (patch: Partial<Pick<DrillSpec, 'outcome' | 'sort' | 'page'>>) => void; onOpenCall: (id: string) => void;
}
export const EnvContext = createContext<RenderEnv | null>(null);
const useEnv = () => { const e = useContext(EnvContext); if (!e) throw new Error('missing render environment'); return e; };

const TITLES: Record<ComponentId, string> = {
  calls_card: 'Calls', answer_rate_card: 'Answer rate', conversion_card: 'Conversion rate',
  daily_trend: 'Daily performance', daily_call_volume: 'Daily call volume',
  campaign_table: 'Campaigns', change_ranking: 'Answer-rate change by campaign', call_list: 'Unanswered calls',
};

function Card({ id, children }: { id: ComponentId; children: ReactNode }) {
  const { layout } = useEnv();
  const item = layout.items.find((i) => i.id === id);
  return (
    <article data-scene-id={id} data-pinned={item?.pinned ? 'true' : 'false'}
      style={{ gridColumn: item?.width === 'half' ? 'span 1' : 'span 2', borderTop: `4px solid ${PALETTE[item?.accent ?? 'brand']}` }}
      className="card">
      <h3>{TITLES[id]}{item?.pinned ? <span className="pin" title="Pinned"> 📌</span> : null}</h3>
      {children}
    </article>
  );
}

const METRIC_FOR: Record<string, 'calls' | 'answer_rate' | 'conversion_rate'> = { calls_card: 'calls', answer_rate_card: 'answer_rate', conversion_card: 'conversion_rate' };

export const MetricCard = defineComponent({
  name: 'MetricCard',
  description: 'A KPI card (calls, answer rate or conversion rate). The application fills the value from the demo data.',
  props: z.object({ componentId: z.enum(['calls_card', 'answer_rate_card', 'conversion_card']) }),
  component: ({ props }) => {
    const { data } = useEnv();
    const t = data.totals;
    const id = props.componentId;
    const main = METRIC_FOR[id] === 'calls' ? count(t.calls) : METRIC_FOR[id] === 'answer_rate' ? pct(t.answerRate) : pct(t.conversionRate);
    const sub = id === 'calls_card' ? `${count(t.answered)} answered` : id === 'answer_rate_card' ? `${count(t.answered)} answered of ${count(t.calls)} calls` : `${count(t.conversions)} conversions of ${count(t.answered)} answered`;
    return <Card id={id}><div className="big" data-testid={`${id}-value`}>{main}</div><div className="muted">{sub}</div></Card>;
  },
});

function Bars({ points, series }: { points: { date: string; calls: number; answered: number }[]; series: 'both' | 'calls' }) {
  const max = Math.max(1, ...points.map((p) => p.calls));
  const w = 560, h = 140, bw = w / points.length;
  return (
    <svg viewBox={`0 0 ${w} ${h + 18}`} role="img" aria-label="daily chart" className="chart">
      {points.map((p, i) => (
        <g key={p.date} data-date={p.date}>
          <rect x={i * bw + 6} y={h - (p.calls / max) * h} width={bw - 12} height={(p.calls / max) * h} fill="#d9d2f7"><title>{`${p.date}: ${p.calls} calls`}</title></rect>
          {series === 'both' && <rect x={i * bw + 14} y={h - (p.answered / max) * h} width={bw - 28} height={(p.answered / max) * h} fill="#4c0eb6"><title>{`${p.date}: ${p.answered} answered`}</title></rect>}
          <text x={i * bw + bw / 2} y={h + 14} textAnchor="middle" fontSize="10" fill="#5f6368">{p.date.slice(5)}</text>
        </g>
      ))}
    </svg>
  );
}

export const DailyTrend = defineComponent({
  name: 'DailyTrend',
  description: 'Daily chart. daily_trend shows calls and answered; daily_call_volume shows calls only.',
  props: z.object({ componentId: z.enum(['daily_trend', 'daily_call_volume']) }),
  component: ({ props }) => {
    const { data } = useEnv();
    return <Card id={props.componentId}><Bars points={data.trend} series={props.componentId === 'daily_trend' ? 'both' : 'calls'} />
      {props.componentId === 'daily_trend' && <div className="muted">Light: calls · Purple: answered</div>}</Card>;
  },
});

const COLS: Record<RankMetric, { head: string; cell: (s: Summary) => string }> = {
  calls: { head: 'Calls', cell: (s) => count(s.calls) }, answered: { head: 'Answered', cell: (s) => count(s.answered) },
  answer_rate: { head: 'Answer rate', cell: (s) => pct(s.answerRate) }, conversions: { head: 'Conversions', cell: (s) => count(s.conversions) },
  conversion_rate: { head: 'Conv. rate', cell: (s) => pct(s.conversionRate) }, unanswered_calls: { head: 'Unanswered', cell: (s) => count(s.unanswered) },
};
const ALL_COLS: RankMetric[] = ['calls', 'answered', 'answer_rate', 'conversions', 'conversion_rate'];

export const CampaignTable = defineComponent({
  name: 'CampaignTable',
  description: 'Per-campaign comparison table; clicking a row drills into that campaign. A ranking shows only the requested metric columns.',
  props: z.object({ componentId: z.enum(['campaign_table']) }),
  component: ({ props }) => {
    const { data, onSelectCampaign } = useEnv();
    const cols = data.spec.columns ?? ALL_COLS;
    const ranked = !!data.spec.rank;
    return (
      <Card id={props.componentId}>
        <table><thead><tr>{ranked && <th>#</th>}<th>Campaign</th>{cols.map((c) => <th key={c}>{COLS[c].head}</th>)}</tr></thead>
          <tbody>{data.rows.map((r, i) => (
            <tr key={r.campaignId} data-campaign={r.campaignId} onClick={() => onSelectCampaign(r.campaignId)} className="click" tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && onSelectCampaign(r.campaignId)}>
              {ranked && <td>{i + 1}</td>}
              <td>{campaignName(r.campaignId)}{r.summary.calls > 0 && r.summary.calls < MIN_SAMPLE && <span className="badge notice low" title={`fewer than ${MIN_SAMPLE} calls`}>low sample</span>}</td>
              {cols.map((c) => <td key={c}>{COLS[c].cell(r.summary)}</td>)}</tr>))}</tbody></table>
      </Card>
    );
  },
});

export const ChangeRanking = defineComponent({
  name: 'ChangeRanking',
  description: 'Ranking of campaigns by answer-rate change versus the previous equal-length period.',
  props: z.object({ componentId: z.enum(['change_ranking']) }),
  component: ({ props }) => {
    const { data, onSelectCampaign } = useEnv();
    return (
      <Card id={props.componentId}>
        <div className="muted" data-testid="periods">Current: {data.filters.range.start} to {data.filters.range.end} · Comparison: {data.previous.start} to {data.previous.end}</div>
        <table><thead><tr><th>#</th><th>Campaign</th><th>Current</th><th>Previous</th><th>Change</th><th>Calls (cur / prev)</th><th></th></tr></thead>
          <tbody>{data.change.map((r, i) => (
            <tr key={r.campaignId} data-campaign={r.campaignId} onClick={() => onSelectCampaign(r.campaignId)} className="click">
              <td>{r.changePp === null ? DASH : i + 1}</td><td>{campaignName(r.campaignId)}{r.changePp !== null && (r.current.calls < MIN_SAMPLE || r.previous.calls < MIN_SAMPLE) && <span className="badge notice low" title={`fewer than ${MIN_SAMPLE} calls in a period`}>low sample</span>}</td><td>{pct(r.current.answerRate)}</td><td>{pct(r.previous.answerRate)}</td>
              <td data-testid={`change-${r.campaignId}`} className={r.changePp === null ? 'muted' : r.changePp < 0 ? 'neg' : 'pos'}>{pp(r.changePp)}</td>
              <td>{count(r.current.calls)} / {count(r.previous.calls)}</td>
              <td>{r.current.calls > 0 && <button data-testid={`drill-${r.campaignId}`} onClick={(e) => { e.stopPropagation(); onSelectCampaign(r.campaignId); }}>View unanswered calls</button>}</td></tr>))}</tbody></table>
        {data.change.some((r) => r.changePp === null) && <div className="muted">{CANNOT_COMPARE}: no calls in one of the two periods.</div>}
      </Card>
    );
  },
});

export const CallList = defineComponent({
  name: 'CallList',
  description: 'Unanswered calls (no answer, busy, failed) of the drilled campaign, with outcome filter, time sort and paging.',
  props: z.object({ componentId: z.enum(['call_list']) }),
  component: ({ props }) => {
    const { data, onDrill, onOpenCall } = useEnv();
    const d = data.drill, spec = data.spec.drill;
    return (
      <Card id={props.componentId}>
        {!d || !spec ? <div className="muted">Select a campaign (click a table row, or ask) to see its unanswered calls.</div> : (<>
          <div className="muted" data-testid="drill-summary">{campaignName(spec.campaignId)} · {d.total} unanswered calls · {data.filters.range.start} to {data.filters.range.end}</div>
          <div className="bar">
            <label>Outcome <select value={spec.outcome ?? ''} data-testid="outcome-filter" onChange={(e) => onDrill({ outcome: (e.target.value || undefined) as DrillSpec['outcome'], page: 1 })}>
              <option value="">All unanswered</option><option value="no_answer">No answer</option><option value="busy">Busy</option><option value="failed">Failed</option></select></label>
            <button data-testid="sort-time" onClick={() => onDrill({ sort: spec.sort === 'desc' ? 'asc' : 'desc', page: 1 })}>Time {spec.sort === 'desc' ? '↓ newest first' : '↑ oldest first'}</button>
            <button data-testid="page-prev" disabled={d.page <= 1} onClick={() => onDrill({ page: d.page - 1 })}>‹ Prev</button>
            <span data-testid="page-label">Page {d.page} of {d.pages}</span>
            <button data-testid="page-next" disabled={d.page >= d.pages} onClick={() => onDrill({ page: d.page + 1 })}>Next ›</button>
          </div>
          {d.total === 0 ? <div className="muted" data-testid="drill-empty">No unanswered calls match this outcome in the date range.</div> : (
            <table><thead><tr><th>Time (UTC)</th><th>Phone (synthetic)</th><th>Outcome</th></tr></thead>
              <tbody>{d.rows.map((r) => (
                <tr key={r.id} data-call={r.id} data-outcome={r.outcome} data-time={r.startedAt} className="click" tabIndex={0} onClick={() => onOpenCall(r.id)} onKeyDown={(e) => e.key === 'Enter' && onOpenCall(r.id)}>
                  <td>{r.startedAt.replace('T', ' ').slice(0, 16)}</td><td>{r.phone}</td><td>{r.outcome}</td></tr>))}</tbody></table>)}</>)}
      </Card>
    );
  },
});

const CHILD = [MetricCard, DailyTrend, CampaignTable, ChangeRanking, CallList];
export const Report = defineComponent({
  name: 'Report',
  description: 'Root container; children are report components in display order.',
  props: z.object({ children: z.array(z.union(CHILD.map((c) => c.ref) as [typeof MetricCard.ref, ...(typeof MetricCard.ref)[]])) }),
  component: ({ props, renderNode }) => <section className="grid">{renderNode(props.children)}</section>,
});

export const library = createLibrary({ components: [Report, ...CHILD], root: 'Report' });
export const LIBRARY_COMPONENTS = ['Report', ...CHILD.map((c) => c.name)];

const CONSTRUCTOR: Record<ComponentId, string> = {
  calls_card: 'MetricCard', answer_rate_card: 'MetricCard', conversion_card: 'MetricCard',
  daily_trend: 'DailyTrend', daily_call_volume: 'DailyTrend', campaign_table: 'CampaignTable', change_ranking: 'ChangeRanking', call_list: 'CallList',
};
/** OpenUI Lang program for the ordered components (built by the app from validated ids). */
export function programFor(order: ComponentId[]): string {
  return [`root = Report([${order.map((_, i) => `c${i}`).join(', ')}])`, ...order.map((id, i) => `c${i} = ${CONSTRUCTOR[id]}("${id}")`)].join('\n');
}
/** Unknown constructors are silently dropped by the renderer, so reject them before rendering. */
export function unknownComponents(program: string): string[] {
  const names = [...program.matchAll(/=\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]);
  return names.filter((n) => !LIBRARY_COMPONENTS.includes(n));
}
