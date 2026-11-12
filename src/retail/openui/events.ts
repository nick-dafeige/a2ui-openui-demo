/**
 * Semantic UI events (v0.5.0). Components never touch the task: they emit one of these, and the application decides whether
 * it is allowed (message still current, control really in the validated program, value legal) and what it means as a business
 * change. Typed language and components therefore end in the SAME `Intent`, handled by the SAME `applyIntent`.
 */
import { validateIntent, type Intent } from '../intent.ts';
import type { Binding, EvidenceBundle } from './bundle.ts';

export const SELECT_FIELDS = ['order', 'plan', 'returnMethod', 'locationPref', 'servicePoint', 'delivery'] as const;
export type SelectField = (typeof SELECT_FIELDS)[number];
export const DATE_FIELDS = ['deadline', 'pickupDate'] as const;
/** Fields a plain "apply" button may set. Dates are deliberately absent: a date change goes through a what-if the application computed (adopt) or a DatePicker, never a date the model wrote. */
export const APPLY_FIELDS = ['deliveryTarget', 'planChoice', 'returnMethod', 'locationPref', 'servicePointId', 'pickupSlot', 'preference'] as const;

export type UiEvent =
  | { kind: 'select'; field: SelectField; ref: string }
  | { kind: 'multi'; field: 'symptoms'; refs: string[] }
  | { kind: 'date'; field: 'deadline' | 'pickupDate'; value: string }
  | { kind: 'slot'; value: string }
  | { kind: 'form'; values: { pickupDate?: string; pickupSlot?: string; deadline?: string } }
  | { kind: 'adopt'; ref: string }
  | { kind: 'apply'; field: (typeof APPLY_FIELDS)[number]; value: string }
  | { kind: 'ask'; text: string };

/** What the validated program offers: recorded when the program is accepted, checked again when a control is used. */
export type Control =
  | { kind: 'select'; field: SelectField; refs: string[] }
  | { kind: 'multi'; field: 'symptoms'; refs: string[] }
  | { kind: 'date'; field: 'deadline' | 'pickupDate' }
  | { kind: 'slot' }
  | { kind: 'form'; fields: ('pickupDate' | 'pickupSlot' | 'deadline')[] }
  | { kind: 'adopt'; ref: string }
  | { kind: 'apply'; field: (typeof APPLY_FIELDS)[number]; value: string }
  | { kind: 'ask'; text: string };

const valueOf = (b: Binding | undefined): string | null => (!b ? null : b.kind === 'order' ? b.id : b.kind === 'plan' ? b.plan : b.kind === 'sp' ? b.id : b.kind === 'addr' ? b.id : b.kind === 'opt' ? b.value : null);

/** Map an event to the business Intent, or explain why it is refused. Also checks the event is one the message really offered. */
export function eventToIntent(ev: UiEvent, controls: Control[], bundle: EvidenceBundle): { ok: true; intent: Intent; label: string } | { ok: false; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, reason });
  const done = (raw: Record<string, unknown>, label: string) => { const v = validateIntent(raw); return v.ok ? { ok: true as const, intent: v.intent, label } : bad(`illegal_value:${v.reason}`); };
  switch (ev.kind) {
    case 'select': {
      const c = controls.find((x) => x.kind === 'select' && x.field === ev.field);
      if (!c || c.kind !== 'select' || !c.refs.includes(ev.ref)) return bad('control_not_offered');
      const b = bundle.bindings[ev.ref]; const v = valueOf(b);
      if (!b || v === null) return bad('unknown_binding');
      const label = b.kind === 'order' ? b.name : b.kind === 'plan' ? b.label : b.kind === 'sp' ? b.name : b.kind === 'addr' ? b.label : b.kind === 'opt' ? b.label : v;
      if (ev.field === 'order') return done({ orderId: v }, label);
      if (ev.field === 'plan') return done({ planChoice: v }, label);
      if (ev.field === 'returnMethod') return done({ returnMethod: v, ...(v === 'store' ? { wantsAddress: true } : {}) }, label);
      if (ev.field === 'locationPref') return done({ locationPref: v }, label);
      if (ev.field === 'servicePoint') return done({ servicePointId: v }, label);
      return b.kind === 'addr' && (b.id.startsWith('home') || b.id.startsWith('company')) ? done({ deliveryTarget: b.id.startsWith('home') ? 'home' : 'company' }, label) : bad('delivery_address_not_supported');
    }
    case 'multi': {
      const c = controls.find((x) => x.kind === 'multi');
      if (!c || c.kind !== 'multi' || ev.refs.length === 0 || !ev.refs.every((r) => c.refs.includes(r))) return bad('control_not_offered');
      const syms = ev.refs.map((r) => valueOf(bundle.bindings[r])).filter((x): x is string => !!x);
      return done({ symptoms: syms }, ev.refs.map((r) => (bundle.bindings[r] as { label?: string })?.label ?? r).join(', '));
    }
    case 'date': {
      const offered = controls.some((x) => (x.kind === 'date' && x.field === ev.field) || (x.kind === 'form' && x.fields.includes(ev.field)));
      return offered ? done({ [ev.field]: ev.value }, ev.value) : bad('control_not_offered');
    }
    case 'slot': return controls.some((x) => x.kind === 'slot' || (x.kind === 'form' && x.fields.includes('pickupSlot'))) ? done({ pickupSlot: ev.value }, ev.value) : bad('control_not_offered');
    case 'form': {
      const f = controls.find((x) => x.kind === 'form');
      if (!f || f.kind !== 'form') return bad('control_not_offered');
      for (const k of Object.keys(ev.values)) if (!f.fields.includes(k as never)) return bad('field_not_in_form');
      if (f.fields.some((k) => !(ev.values as Record<string, string | undefined>)[k])) return bad('form_incomplete');
      return done(ev.values, Object.values(ev.values).join(', '));
    }
    case 'adopt': {
      if (!controls.some((x) => x.kind === 'adopt' && x.ref === ev.ref)) return bad('control_not_offered');
      const b = bundle.bindings[ev.ref];
      return b?.kind === 'compare' && b.applyIntent ? done(b.applyIntent as Record<string, unknown>, 'Use this') : bad('nothing_to_adopt');
    }
    case 'apply': return controls.some((x) => x.kind === 'apply' && x.field === ev.field && x.value === ev.value) ? done({ [ev.field]: ev.value }, ev.value) : bad('control_not_offered');
    case 'ask': return controls.some((x) => x.kind === 'ask' && x.text === ev.text) ? { ok: true, intent: {}, label: ev.text } : bad('control_not_offered');
  }
}
