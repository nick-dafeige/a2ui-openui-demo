/**
 * The Retail component library (v0.5.0) for OpenUI Lang. The MODEL composes these (layout, content, inputs); the APPLICATION
 * owns every fact (components show bindings, never model-written figures) and every state change (components emit semantic
 * events; they do not touch the task). Generic pieces, not per-step cards: the same components answer different questions.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import { createLibrary, defineComponent, useTriggerAction } from '@openuidev/react-lang';
import { z } from 'zod/v4';
import { MapView, RealMap, type MapPin } from '../MapView.tsx';
import { PICKUP_SLOTS, PLAN_LABEL } from '../data.ts';
import { appointmentSlots, dateText, earliestPickup, latestPickup, slotAvailable, addDays } from '../rules.ts';
import { RETAIL_TODAY } from '../data.ts';
import type { TaskState } from '../state.ts';
import type { Binding, EvidenceBundle, QuoteView } from './bundle.ts';
import { DATE_FIELDS, SELECT_FIELDS, APPLY_FIELDS, type UiEvent } from './events.ts';

export const LIBRARY_VERSION = 'retail-ui-lib/1 (@openuidev/react-lang 1.1.0)';

/** Everything components may read. `state` is the task AS IT WAS when the message was made (frozen with the message). */
export interface RetailEnv { bundle: EvidenceBundle; state: TaskState; live: boolean; emit: (ev: UiEvent, label: string) => void; draft: Draft; setDraft: (p: Partial<Draft>) => void }
export interface Draft { pickupDate?: string; pickupSlot?: string; deadline?: string; servicePoint?: string; symptoms?: string[] }
export const EnvContext = createContext<RetailEnv | null>(null);
const useEnv = () => { const e = useContext(EnvContext); if (!e) throw new Error('missing retail environment'); return e; };
const FormCtx = createContext<{ inForm: boolean }>({ inForm: false });
const useEmit = () => {
  const env = useEnv(); const trigger = useTriggerAction();
  return (ev: UiEvent, label: string) => { if (!env.live) return; trigger(label, undefined, { type: 'retail_event', params: { event: ev, label } }); };
};
const bind = (env: RetailEnv, ref: string): Binding | undefined => env.bundle.bindings[ref];

function Missing({ what }: { what: string }) { return <span className="badge error" data-testid="ou-missing">{what}</span>; }

// ----- layout -----
const Box = ({ cls, children }: { cls: string; children: ReactNode }) => <div className={cls}>{children}</div>;

// ----- content -----
export const Text = defineComponent({
  name: 'Text', description: 'A short paragraph in plain words. Every figure (money, date, days, km) must appear in the facts; never invent one.',
  props: z.object({ text: z.string().max(500) }),
  component: ({ props }) => <p className="ou-text" data-testid="ou-text">{props.text}</p>,
});
export const Notice = defineComponent({
  name: 'Notice', description: 'A highlighted remark. tone: info | warning | success. Use warning only for a real risk (for example a plan that misses the deadline).',
  props: z.object({ tone: z.enum(['info', 'warning', 'success']), text: z.string().max(300) }),
  component: ({ props }) => <div className={`ou-notice ${props.tone}`} data-testid="ou-notice" role="note">{props.text}</div>,
});
export const OrderSummary = defineComponent({
  name: 'OrderSummary', description: 'The item: name, order id and purchase date. ref = an order.* binding.',
  props: z.object({ ref: z.string() }),
  component: ({ props }) => { const b = bind(useEnv(), props.ref); return b?.kind === 'order' ? <div className="ou-box" data-testid="ou-order"><b>{b.name}</b><br /><span className="muted">Order {b.id} · purchased {b.purchased}</span></div> : <Missing what="order" />; },
});
export const WarrantyStatus = defineComponent({
  name: 'WarrantyStatus', description: 'Whether the item is in warranty and until when. ref = an order.* binding.',
  props: z.object({ ref: z.string() }),
  component: ({ props }) => { const b = bind(useEnv(), props.ref); return b?.kind === 'order' ? <span className={`badge ${b.inWarranty ? 'live' : 'error'}`} data-testid="ou-warranty">{b.inWarranty ? `In warranty until ${b.warrantyEnd}` : `Out of warranty (expired ${b.warrantyEnd})`}</span> : <Missing what="warranty" />; },
});
export const METRICS = ['eta', 'total', 'timing', 'refund', 'shipping', 'change'] as const;
const metricValue = (q: QuoteView, m: (typeof METRICS)[number]): { label: string; value: string } => {
  switch (m) {
    case 'eta': return { label: q.etaLabel, value: q.eta ?? 'not available' };
    case 'total': return { label: 'Total cost', value: q.total ?? 'not available' };
    case 'timing': return { label: 'Against your deadline', value: q.timing };
    case 'refund': return { label: 'Refund amount', value: q.refund ?? 'not applicable' };
    case 'shipping': return { label: 'Shipping', value: q.shipping ?? 'not available' };
    case 'change': return { label: 'Versus now', value: q.change ?? 'no comparison' };
  }
};
export const QuoteMetric = defineComponent({
  name: 'QuoteMetric', description: 'One figure of one plan quote, computed by the application. ref = a quote.* binding; metric = eta (arrival date) | total | timing (against the deadline) | refund | shipping | change (versus the current settings, only on .alt quotes).',
  props: z.object({ ref: z.string(), metric: z.enum(METRICS) }),
  component: ({ props }) => {
    const b = bind(useEnv(), props.ref);
    if (b?.kind !== 'quote') return <Missing what="quote" />;
    const m = metricValue(b.quote, props.metric);
    return <div className="ou-metric" data-testid="ou-metric" data-ref={props.ref} data-metric={props.metric}><span className="muted">{b.quote.label} · {m.label}</span><b>{m.value}</b></div>;
  },
});
export const QuoteComparison = defineComponent({
  name: 'QuoteComparison', description: 'A what-if table: every plan now versus under the assumption, with arrival, cost, timing and the change. ref = a cmp.* binding. It is only a comparison: nothing is changed by showing it.',
  props: z.object({ ref: z.string() }),
  component: ({ props }) => {
    const b = bind(useEnv(), props.ref);
    if (b?.kind !== 'compare') return <Missing what="comparison" />;
    return (
      <div className="ou-box" data-testid="ou-compare" data-ref={props.ref}>
        <div><span className="badge notice" data-testid="ou-whatif-badge">What-if only · nothing was changed</span> <span className="muted">If {b.assumptions.join(' and ')}{b.deadlineText ? ` (latest receive date ${b.deadlineText})` : ''}</span></div>
        <table className="ou-table"><thead><tr><th>Plan</th><th>Now</th><th>If</th><th>Change</th></tr></thead><tbody>
          {b.alt.map((a, i) => { const n = b.now[i]; return <tr key={a.plan} data-testid={`ou-cmp-row-${a.plan}`}>
            <td>{a.label}</td><td>{n?.eligible ? `${n.eta} · ${n.total}` : 'not available'}</td><td>{a.eligible ? `${a.eta} · ${a.total}` : 'not available'}</td><td>{a.eligible ? (a.plan === 'refund' ? 'gives no working device' : `${a.change ?? ''}${a.timing ? ` · ${a.timing}` : ''}`) : a.reason}</td></tr>; })}
        </tbody></table>
      </div>
    );
  },
});
export const AddressSummary = defineComponent({
  name: 'AddressSummary', description: 'A saved address with its zone. ref = an addr.* binding.',
  props: z.object({ ref: z.string() }),
  component: ({ props }) => { const b = bind(useEnv(), props.ref); return b?.kind === 'addr' ? <div className="ou-box" data-testid="ou-address"><b>{b.label}</b> <span className="badge notice">{b.zone}</span><br /><span className="muted">{b.detail}, {b.floor}</span></div> : <Missing what="address" />; },
});
export const ServicePointSummary = defineComponent({
  name: 'ServicePointSummary', description: 'One service point: name, distance, opening hours and whether an appointment is needed. ref = an sp.* binding.',
  props: z.object({ ref: z.string() }),
  component: ({ props }) => { const b = bind(useEnv(), props.ref); return b?.kind === 'sp' ? <div className="ou-box" data-testid="ou-sp" data-id={b.id}><b>{b.name}</b><br /><span className="muted">{b.distanceKm} km from {b.nearLabel} · {b.slotsText} · handles {b.handles.join(', ')}</span></div> : <Missing what="service point" />; },
});

// ----- inputs -----
export const Map = defineComponent({
  name: 'Map', description: 'A schematic map (no tiles) of saved addresses and service points. refs = addr.* and sp.* bindings (max 8). Clicking a service point highlights it; it does not change anything by itself.',
  props: z.object({ refs: z.array(z.string()).max(8) }),
  component: ({ props }) => {
    const env = useEnv();
    const pins: MapPin[] = props.refs.flatMap((r): MapPin[] => { const b = bind(env, r); return b?.kind === 'sp' ? [{ id: b.id, x: b.x, y: b.y, label: b.name.replace(' (demo)', ''), kind: 'service', selected: env.draft.servicePoint === b.id }] : b?.kind === 'addr' ? [{ id: b.id, x: b.x, y: b.y, label: b.label.replace(/^.*· /, ''), kind: 'address' }] : []; });
    const focus = pins.find((p) => p.id === env.draft.servicePoint) ?? pins.find((p) => p.kind === 'service') ?? pins[0];
    return (
      <>
        <MapView pins={pins} testId="ou-map" caption="Schematic map: positions are illustrative, not a route" onPin={env.live ? (id) => { if (pins.find((p) => p.id === id)?.kind === 'service') env.setDraft({ servicePoint: id }); } : undefined} />
        {focus && <RealMap at={focus} label={focus.label} />}
      </>
    );
  },
});
const optLabel = (b: Binding | undefined): { title: string; sub: string } => !b ? { title: '?', sub: '' } : b.kind === 'order' ? { title: b.name, sub: `${b.inWarranty ? 'In' : 'Out of'} warranty · order ${b.id}` } : b.kind === 'plan' ? { title: b.label, sub: b.eligible ? '' : `Not available${b.reason ? `: ${b.reason}` : ''}` }
  : b.kind === 'sp' ? { title: b.name, sub: `${b.distanceKm} km · ${b.slotsText}` } : b.kind === 'addr' ? { title: b.label, sub: `${b.zone}` } : b.kind === 'opt' ? { title: b.label, sub: '' } : { title: '?', sub: '' };

export const SingleChoice = defineComponent({
  name: 'SingleChoice', description: `Pick exactly one option; choosing it is a decision and is applied. field: ${SELECT_FIELDS.join(' | ')}. options = bindings that fit the field: order.* for order, plan.* for plan, method.* for returnMethod, loc.* for locationPref, sp.* for servicePoint, addr.* for delivery.`,
  props: z.object({ field: z.enum(SELECT_FIELDS), options: z.array(z.string()).min(1).max(6), label: z.string().max(80).optional() }),
  component: ({ props }) => {
    const env = useEnv(); const emit = useEmit(); const [chosen, setChosen] = useState<string | null>(null);
    return (
      <div className="ou-box" data-testid={`ou-choice-${props.field}`} role="radiogroup" aria-label={props.label ?? props.field}>
        {props.label && <div className="muted">{props.label}</div>}
        {props.options.map((r) => { const o = optLabel(bind(env, r)); const unavailable = bind(env, r)?.kind === 'plan' && !(bind(env, r) as { eligible: boolean }).eligible; const hi = chosen === r || (props.field === 'servicePoint' && env.draft.servicePoint === (bind(env, r) as { id?: string })?.id);
          return <button key={r} type="button" role="radio" aria-checked={hi} className={`ou-opt${hi ? ' hi' : ''}`} disabled={!env.live || unavailable} data-testid={`ou-opt-${r}`} onClick={() => { setChosen(r); emit({ kind: 'select', field: props.field, ref: r }, o.title); }}><b>{o.title}</b>{o.sub && <span className="muted"> · {o.sub}</span>}{hi && <span className="ou-selected-mark" aria-hidden="true"> ✓</span>}</button>; })}
      </div>
    );
  },
});
export const MultiChoice = defineComponent({
  name: 'MultiChoice', description: 'Pick one or more options, then confirm. field: symptoms. options = symptom.* bindings.',
  props: z.object({ field: z.enum(['symptoms']), options: z.array(z.string()).min(1).max(6), submitLabel: z.string().max(40).optional() }),
  component: ({ props }) => {
    const env = useEnv(); const emit = useEmit(); const picked = env.draft.symptoms ?? [];
    return (
      <div className="ou-box" data-testid="ou-multi-symptoms">
        {props.options.map((r) => { const o = optLabel(bind(env, r)); return <label key={r} className="rt-chip"><input type="checkbox" disabled={!env.live} data-testid={`ou-check-${r}`} checked={picked.includes(r)} onChange={(e) => env.setDraft({ symptoms: e.target.checked ? [...picked, r] : picked.filter((x) => x !== r) })} />{o.title}</label>; })}
        <div><button type="button" className="primary" disabled={!env.live || picked.length === 0} data-testid="ou-multi-submit" onClick={() => emit({ kind: 'multi', field: 'symptoms', refs: picked }, picked.map((r) => optLabel(bind(env, r)).title).join(', '))}>{props.submitLabel ?? 'Confirm'}</button></div>
      </div>
    );
  },
});
export const QuickReply = defineComponent({
  name: 'QuickReply', description: 'A suggested next step as a button. kind "adopt": apply a what-if you showed (target = its cmp.* binding; the application derives the change, value omitted). kind "apply": make one simple change (target = field: deliveryTarget (home|company) | planChoice (exchange|repair|refund) | returnMethod (courier|store) | locationPref (home|company) | servicePointId (sp-1..) | pickupSlot | preference (fastest|cheapest), value = its value; never a date: a date change is adopted from a what-if or picked with a DatePicker). kind "ask": send a follow-up question to the assistant (target = the question). Nothing happens until the user presses it.',
  props: z.object({ label: z.string().min(1).max(48), kind: z.enum(['adopt', 'apply', 'ask']), target: z.string().max(160), value: z.string().max(40).optional() }),
  component: ({ props }) => {
    const env = useEnv(); const emit = useEmit();
    const ev: UiEvent = props.kind === 'adopt' ? { kind: 'adopt', ref: props.target } : props.kind === 'ask' ? { kind: 'ask', text: props.target } : { kind: 'apply', field: props.target as (typeof APPLY_FIELDS)[number], value: props.value ?? '' };
    return <button type="button" className="ou-quick" disabled={!env.live} data-testid="ou-quick" data-kind={props.kind} onClick={() => emit(ev, props.label)}>{props.label}</button>;
  },
});
export const DatePicker = defineComponent({
  name: 'DatePicker', description: 'Pick a date. field: deadline (latest day the user needs a working device) | pickupDate (courier pickup or drop-off day). The application sets the allowed range. Alone it applies on "Use this date"; inside a Form it only fills the form.',
  props: z.object({ field: z.enum(DATE_FIELDS), label: z.string().max(60).optional() }),
  component: ({ props }) => {
    const env = useEnv(); const emit = useEmit(); const { inForm } = useContext(FormCtx);
    const [local, setLocal] = useState('');
    const value = inForm ? (props.field === 'deadline' ? env.draft.deadline : env.draft.pickupDate) ?? '' : local;
    const min = props.field === 'deadline' ? addDays(RETAIL_TODAY, 1) : earliestPickup(); const max = props.field === 'deadline' ? (env.state.departDate ?? addDays(RETAIL_TODAY, 60)) : latestPickup();
    const set = (v: string) => (inForm ? env.setDraft(props.field === 'deadline' ? { deadline: v } : { pickupDate: v }) : setLocal(v));
    const ok = !!value && value >= min && value <= max;
    return (
      <div className="ou-box" data-testid={`ou-date-${props.field}`}>
        <label className="rt-datefield">{props.label ?? (props.field === 'deadline' ? 'Latest day you need it' : 'Day')}<input type="date" disabled={!env.live} min={min} max={max} value={value} data-testid={`ou-date-input-${props.field}`} onChange={(e) => set(e.target.value)} /></label>
        {value && !ok && <div className="rt-err" role="alert">Choose a day between {dateText(min)} and {dateText(max)}.</div>}
        {!inForm && <button type="button" className="primary" disabled={!env.live || !ok} data-testid={`ou-date-use-${props.field}`} onClick={() => emit({ kind: 'date', field: props.field, value }, dateText(value))}>Use this date</button>}
      </div>
    );
  },
});
export const TimeSlotPicker = defineComponent({
  name: 'TimeSlotPicker', description: 'Pick a time window for the courier or for a store appointment. The application lists only windows that are inside opening hours and marks full ones. It needs a date (from the state or from a DatePicker in the same Form). Alone it applies when a window is chosen; inside a Form it only fills the form.',
  props: z.object({ label: z.string().max(60).optional() }),
  component: ({ props }) => {
    const env = useEnv(); const emit = useEmit(); const { inForm } = useContext(FormCtx);
    const date = env.draft.pickupDate ?? env.state.pickup.date;
    const sp = env.state.pickup.method === 'store' ? env.state.pickup.servicePointId : null;
    const slots = sp ? appointmentSlots(sp, date ?? null) : PICKUP_SLOTS.map((s) => ({ slot: s as string, ok: !date || slotAvailable(date, s), why: date && !slotAvailable(date, s) ? 'Full' : null }));
    return (
      <div className="ou-box" data-testid="ou-slots" role="radiogroup" aria-label={props.label ?? 'Time window'}>
        <div className="muted">{props.label ?? 'Time window'}{date ? ` · ${dateText(date)}` : ' · choose a day first'}</div>
        {slots.map((s) => <button key={s.slot} type="button" className={`ou-opt${env.draft.pickupSlot === s.slot ? ' hi' : ''}`} disabled={!env.live || !date || !s.ok} data-testid={`ou-slot-${s.slot}`}
          onClick={() => (inForm ? env.setDraft({ pickupSlot: s.slot }) : emit({ kind: 'slot', value: s.slot }, s.slot))}>{s.slot}{s.ok ? '' : ' (full)'}</button>)}
      </div>
    );
  },
});
const LEAVES = [Text, Notice, OrderSummary, WarrantyStatus, QuoteMetric, QuoteComparison, AddressSummary, ServicePointSummary, Map, SingleChoice, MultiChoice, QuickReply, DatePicker, TimeSlotPicker] as const;
const leafRefs = LEAVES.map((c) => c.ref) as unknown as [typeof Text.ref, ...(typeof Text.ref)[]];

export const Form = defineComponent({
  name: 'Form', description: 'Several inputs answered together, applied with one button (for example DatePicker + TimeSlotPicker to book an appointment). Children: DatePicker, TimeSlotPicker only. Fields filled inside only draft values; nothing is applied until the button is pressed.',
  props: z.object({ title: z.string().max(80), children: z.array(z.union([DatePicker.ref, TimeSlotPicker.ref])).min(1).max(3), submitLabel: z.string().max(40) }),
  component: ({ props, renderNode }) => {
    const env = useEnv(); const emit = useEmit(); const d = env.draft;
    // which fields this form asks for is recorded by the validator; the button needs all of the form's draft values
    const kids = (props.children as unknown as { props?: { field?: string }; typeName?: string }[]);
    const wants = [...new Set(kids.map((k) => (k?.typeName === 'TimeSlotPicker' ? 'pickupSlot' : k?.props?.field)).filter((x): x is 'pickupDate' | 'pickupSlot' | 'deadline' => !!x))];
    const values = Object.fromEntries(wants.map((k) => [k, d[k]])) as { pickupDate?: string; pickupSlot?: string; deadline?: string };
    const ready = wants.length > 0 && wants.every((k) => !!d[k]);
    return (
      <FormCtx.Provider value={{ inForm: true }}>
        <div className="ou-box ou-form" data-testid="ou-form"><b>{props.title}</b>{renderNode(props.children)}
          <button type="button" className="primary" disabled={!env.live || !ready} data-testid="ou-form-submit" onClick={() => emit({ kind: 'form', values }, Object.values(values).join(', '))}>{props.submitLabel}</button></div>
      </FormCtx.Provider>
    );
  },
});
export const Section = defineComponent({
  name: 'Section', description: 'A titled group of components.',
  props: z.object({ title: z.string().max(80), children: z.array(z.union([...leafRefs, Form.ref])).min(1).max(6) }),
  component: ({ props, renderNode }) => <section className="ou-section" data-testid="ou-section"><h4>{props.title}</h4>{renderNode(props.children)}</section>,
});
export const Columns = defineComponent({
  name: 'Columns', description: 'Two or three components side by side (they stack on a narrow screen).',
  props: z.object({ children: z.array(z.union(leafRefs)).min(2).max(3) }),
  component: ({ props, renderNode }) => <Box cls="ou-columns">{renderNode(props.children)}</Box>,
});
export const Stack = defineComponent({
  name: 'Stack', description: 'Root container: components from top to bottom. Keep it small: only what helps with THIS message.',
  props: z.object({ children: z.array(z.union([...leafRefs, Form.ref, Section.ref, Columns.ref])).min(1).max(8) }),
  component: ({ props, renderNode }) => <div className="ou-stack" data-testid="ou-stack">{renderNode(props.children)}</div>,
});

export const ALL_COMPONENTS = [Stack, Section, Columns, Form, ...LEAVES];
export const library = createLibrary({ components: ALL_COMPONENTS, root: 'Stack' });
export const COMPONENT_NAMES = ALL_COMPONENTS.map((c) => c.name);
export { PLAN_LABEL };
