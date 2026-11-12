/**
 * EvidenceBundle (v0.5.0): the application-owned facts a model-written interface may point at. The model never writes a fee,
 * date, eligibility or distance into a component: it writes a binding id ("quote.q1.alt.exchange", "sp.sp-2") and the
 * component shows what the application computed. A binding has a KIND, and each component only accepts the kinds that fit
 * its meaning, so a total cannot be shown as a date or a service point as an address. The bundle is frozen into the message
 * that used it: later state changes never rewrite what an old message showed.
 */
import { ORDERS, PLAN_IDS, PLAN_LABEL, PLAN_TERMS, RETAIL_TODAY, SERVICE_POINTS, SYMPTOMS, type PlanId } from '../data.ts';
import { dateText, distanceKm, marginText, money, orderById, ZONE_LABEL, zoneOf, type PlanQuote } from '../rules.ts';
import { effectiveLocation, locationAddress, plansKey, quotesOf, revisionOf, type TaskState } from '../state.ts';
import { centsWord, daysWord, isGood, type QueryResult, type QuoteResult } from '../turn.ts';
import type { Intent } from '../intent.ts';

export type BindingKind = 'order' | 'quote' | 'compare' | 'addr' | 'sp' | 'plan' | 'opt' | 'terms';
export interface QuoteView {
  plan: PlanId; label: string; eligible: boolean; reason: string | null; etaLabel: string; eta: string | null; total: string | null; shipping: string | null; serviceFee: string | null;
  refund: string | null; timing: string; change: string | null;   // change = versus the current settings (only for what-if rows)
}
export type Binding =
  | { kind: 'order'; id: string; name: string; purchased: string; warrantyEnd: string; inWarranty: boolean; price: string }
  | { kind: 'quote'; scope: string; quote: QuoteView }
  | { kind: 'compare'; qid: string; assumptions: string[]; deadlineText: string | null; applyIntent: Intent | null; now: QuoteView[]; alt: QuoteView[] }
  | { kind: 'addr'; id: string; label: string; zone: string; detail: string; floor: string; x: number; y: number }
  | { kind: 'sp'; id: string; name: string; detail: string; hours: string; appointment: boolean; handles: string[]; distanceKm: number | null; nearLabel: string | null; x: number; y: number; slotsText: string }
  | { kind: 'plan'; plan: PlanId; label: string; eligible: boolean; reason: string | null }
  | { kind: 'opt'; field: string; value: string; label: string }
  | { kind: 'terms'; plan: PlanId; label: string; lines: string[] };

export interface EvidenceBundle { taskId: string; stateRevision: string; quoteRevision: string; bindings: Record<string, Binding> }

const timingWords = (q: PlanQuote, deadline: string | null): string => (q.plan === 'refund' ? 'gives no working device' : !deadline || q.marginDays === null ? 'timing not known yet' : marginText(q.marginDays));
export function quoteView(q: PlanQuote, deadline: string | null, now?: PlanQuote): QuoteView {
  const eligible = q.eligible;
  const change = eligible && now?.eligible && q.etaDate && now.etaDate
    ? [q.etaDate === now.etaDate ? 'same arrival date' : daysWord(Math.round((Date.parse(q.etaDate) - Date.parse(now.etaDate)) / 86_400_000)), centsWord(q.fees.totalCents - now.fees.totalCents)].join(' · ')
    : null;
  return {
    plan: q.plan, label: PLAN_LABEL[q.plan], eligible, reason: q.reason ?? null, etaLabel: q.etaLabel, eta: eligible && q.etaDate ? dateText(q.etaDate) : null,
    total: eligible ? money(q.fees.totalCents) : null, shipping: eligible ? money(q.fees.shippingCents) : null, serviceFee: eligible ? money(q.fees.serviceCents) : null,
    refund: eligible && q.fees.refundCents != null ? money(q.fees.refundCents) : null, timing: eligible ? timingWords(q, deadline) : `not available (${q.reason ?? 'not eligible'})`, change,
  };
}
const fromRow = (r: QuoteResult['rows'][number], which: 'now' | 'alt', deadline: string | null): QuoteView => ({
  plan: r.plan, label: r.label, eligible: r.eligible, reason: r.reason, etaLabel: r.etaLabel, eta: which === 'now' ? r.etaNow : r.etaAlt,
  total: r.eligible ? (which === 'now' ? r.totalNow : r.totalAlt) : null, shipping: null, serviceFee: null, refund: r.refund,
  timing: !r.eligible ? `not available (${r.reason ?? 'not eligible'})` : r.plan === 'refund' ? 'gives no working device' : which === 'alt' ? (r.marginAltDays == null ? 'timing not known yet' : marginText(r.marginAltDays)) : r.timingNow === 'on_time' ? 'arrives in time' : r.timingNow === 'late' ? 'misses your deadline' : 'timing not known yet',
  change: which === 'alt' && r.eligible && r.deltaDays != null ? `${daysWord(r.deltaDays)} · ${centsWord(r.deltaCents)}` : null,
});

export const OPTION_FIELDS = { method: ['courier', 'store'], loc: ['home', 'company'] } as const;
const SYMPTOM_BINDINGS = SYMPTOMS.map((s) => [`symptom.${s.id}`, s] as const);

/** Build every binding a model may reference this turn. `results` are the read-only tool results of this turn. */
export function buildBundle(t: TaskState, results: QueryResult[], taskId: string): EvidenceBundle {
  const b: Record<string, Binding> = {};
  for (const o of ORDERS) b[`order.${o.id}`] = { kind: 'order', id: o.id, name: o.name, purchased: o.purchased, warrantyEnd: o.warrantyEnd, inWarranty: RETAIL_TODAY <= o.warrantyEnd, price: money(o.priceCents) };
  const now = t.orderId ? quotesOf(t) : [];
  for (const q of now) { b[`quote.now.${q.plan}`] = { kind: 'quote', scope: 'now', quote: quoteView(q, t.deadline) }; }
  for (const p of PLAN_IDS) {
    const q = now.find((x) => x.plan === p);
    b[`plan.${p}`] = { kind: 'plan', plan: p, label: PLAN_LABEL[p], eligible: q ? q.eligible : true, reason: q?.reason ?? null };
    b[`terms.${p}`] = { kind: 'terms', plan: p, label: PLAN_LABEL[p], lines: PLAN_TERMS[p] };
  }
  for (const a of t.book) b[`addr.${a.id}`] = { kind: 'addr', id: a.id, label: a.label, zone: ZONE_LABEL[zoneOf(a)], detail: a.detail, floor: a.floor, x: a.x, y: a.y };
  const loc = effectiveLocation(t); const from = locationAddress(t, loc ?? 'home');
  for (const s of SERVICE_POINTS) b[`sp.${s.id}`] = { kind: 'sp', id: s.id, name: s.name, detail: s.detail, hours: s.hours, appointment: s.appointment, handles: s.supports.map((p) => PLAN_LABEL[p]), distanceKm: distanceKm(s, from), nearLabel: from.label, x: s.x, y: s.y,
    slotsText: s.appointment ? `appointment required, open ${s.hours}` : `walk-in, open ${s.hours}` };
  for (const m of OPTION_FIELDS.method) b[`method.${m}`] = { kind: 'opt', field: 'returnMethod', value: m, label: m === 'courier' ? 'Courier pickup' : 'I drop it off at a service point' };
  for (const l of OPTION_FIELDS.loc) if (l === 'home' || t.book.some((a) => a.kind === 'company')) b[`loc.${l}`] = { kind: 'opt', field: 'locationPref', value: l, label: l === 'home' ? 'Near my home' : 'Near my company' };
  for (const [id, s] of SYMPTOM_BINDINGS) b[id] = { kind: 'opt', field: 'symptoms', value: s.id, label: s.label };
  for (const r of results.filter(isGood)) {
    if (r.tool !== 'quote_plans') continue;
    for (const row of r.rows) { b[`quote.${r.id}.now.${row.plan}`] = { kind: 'quote', scope: `${r.id}.now`, quote: fromRow(row, 'now', t.deadline) }; b[`quote.${r.id}.alt.${row.plan}`] = { kind: 'quote', scope: `${r.id}.alt`, quote: fromRow(row, 'alt', r.deadline) }; }
    b[`cmp.${r.id}`] = { kind: 'compare', qid: r.id, assumptions: r.assumptions, deadlineText: r.deadlineText, applyIntent: r.applyIntent, now: r.rows.map((x) => fromRow(x, 'now', t.deadline)), alt: r.rows.map((x) => fromRow(x, 'alt', r.deadline)) };
  }
  return { taskId, stateRevision: revisionOf(t), quoteRevision: plansKey(t), bindings: b };
}

/** One line per binding for the prompt: id and what it is. Only bindings that make sense now are listed (fewer tokens, fewer wrong references). */
export function bindingCatalog(bundle: EvidenceBundle, t: TaskState): string {
  const lines: string[] = [];
  const hasItem = !!orderById(t.orderId);
  for (const [id, x] of Object.entries(bundle.bindings)) {
    switch (x.kind) {
      case 'order': lines.push(`${id} = order "${x.name}" (${x.inWarranty ? 'in' : 'out of'} warranty)`); break;
      case 'quote': if (hasItem) lines.push(`${id} = ${x.quote.label} quote ${x.scope === 'now' ? 'with the current settings' : x.scope.endsWith('.alt') ? `under the assumptions of ${x.scope.split('.')[0]}` : `now, as a baseline for ${x.scope.split('.')[0]}`}`); break;
      case 'compare': lines.push(`${id} = what-if comparison (${x.assumptions.join(' and ')}); can be adopted with QuickReply kind "adopt"`); break;
      case 'addr': lines.push(`${id} = saved address "${x.label}"`); break;
      case 'sp': lines.push(`${id} = service point "${x.name}" (${x.distanceKm} km from ${x.nearLabel}; ${x.slotsText})`); break;
      case 'plan': lines.push(`${id} = plan option ${x.label}${x.eligible ? '' : ' (not available)'}`); break;
      case 'opt': lines.push(`${id} = option "${x.label}"`); break;
      case 'terms': lines.push(`${id} = terms of ${x.label}`); break;
    }
  }
  return lines.join('\n');
}
