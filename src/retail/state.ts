/**
 * One task state shared by natural language and component events (requirement section 5). Pure helpers only.
 * The conversation is driven by "what is still missing" (`nextNeed`), not by fixed steps. Small cards answer one need
 * each; once answered they collapse into a summary. Quotes and the confirmation card are versioned by keys, so an
 * outdated quote can never be submitted.
 */
import { ORDERS, PICKUP_SLOTS, PLAN_IDS, SERVICE_POINTS, type Address, type PlanId, type Scenario, type SymptomId } from './data.ts';
import type { CaseRecord } from './service.ts';
import { appointmentProblem, checkDeadline, courierPickupSupported, eligibility, fingerprint, isAddressComplete, isPickupDateValid, orderById, quoteAll, quotePlan, servicePointsFor, slotAvailable, type PlanQuote, type Preference, type QuoteInput } from './rules.ts';
import type { Intent } from './intent.ts';
import type { ClientTrace } from './trace.ts';
import type { LangPayload } from './openui/compose.ts';

export interface PickupState { method: 'courier' | 'store' | null; date: string | null; slot: string | null; servicePointId: string | null }
export type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'failed'; message: string; created: boolean | 'unknown' }
  | { status: 'done'; record: CaseRecord };

export interface TaskState {
  orderHint: Intent['orderHint'] | null; showAllOrders: boolean;
  orderId: string | null; symptoms: SymptomId[]; vagueTrip: boolean;   // vagueTrip: user said "next week" but gave no date yet
  departDate: string | null; deadline: string | null;
  preference: Preference | null; planId: PlanId | null;
  locationPref: 'company' | 'home' | null;   // where to look for service points
  book: Address[];            // saved addresses for this scenario (custom ones are appended)
  delivery: Address;          // where the NEW / repaired item goes
  pickupAddr: Address;        // where the OLD item is collected - saved separately from `delivery`
  pickup: PickupState;        // method may be stored before a plan is chosen ("I'll drop it off myself")
  submit: SubmitState;
}

export function initialTask(s: Scenario): TaskState {
  const home = s.addresses.find((a) => a.kind === 'home') ?? s.addresses[0];
  return {
    orderHint: null, showAllOrders: false, orderId: null, symptoms: [], vagueTrip: false, departDate: null, deadline: null, preference: null, planId: null, locationPref: null,
    book: s.addresses, delivery: home, pickupAddr: { ...home }, pickup: { method: null, date: null, slot: null, servicePointId: null }, submit: { status: 'idle' },
  };
}

// ---------- derived quote data ----------
export const quoteInput = (t: TaskState): QuoteInput => ({ orderId: t.orderId, deadline: t.deadline, delivery: t.delivery, pickupDate: t.pickup.date, method: t.pickup.method });
export const quotesOf = (t: TaskState): PlanQuote[] => quoteAll(quoteInput(t));
export const selectedQuote = (t: TaskState): PlanQuote | null => (t.planId ? quotePlan(t.planId, quoteInput(t)) : null);
/** Changes whenever anything a plan comparison depends on changes (order, symptoms, deadline, delivery, pickup date). */
export const plansKey = (t: TaskState): string => fingerprint([t.orderId, [...t.symptoms].sort(), quotesOf(t)]);

/** Orders offered when the user has to pick: those matching the product they named, or all of them on request. */
export const candidateOrders = (t: TaskState) => (t.showAllOrders || !t.orderHint ? ORDERS : ORDERS.filter((o) => o.category === t.orderHint));

/** Where to look for service points: the user's stated place, or home when there is no company address to choose from. */
export function effectiveLocation(t: TaskState): 'company' | 'home' | null {
  if (t.locationPref) return t.locationPref;
  return t.book.some((a) => a.kind === 'company') ? null : 'home';
}
export const locationAddress = (t: TaskState, loc: 'company' | 'home'): Address => t.book.find((a) => a.kind === loc) ?? t.delivery;

export interface SubmitPayload {
  orderId: string; symptoms: SymptomId[]; note: string; deadline: string; departDate: string | null; planId: PlanId;
  delivery: Address | null; pickupAddr: Address; pickup: PickupState; quoteFingerprint: string;
}
/** Everything that blocks the final confirmation, in the order the user should fix it. */
export function readiness(t: TaskState): string[] {
  const p: string[] = [];
  if (!orderById(t.orderId)) p.push('Choose the item that needs service');
  if (t.symptoms.length === 0) p.push('Say what is wrong with it');
  if (!t.deadline) p.push('Confirm the latest receive date'); else { const c = checkDeadline(t.deadline, t.departDate); if (!c.ok) p.push(c.message); }
  if (p.length) return p;
  if (!t.planId) { p.push('Choose a service plan'); return p; }
  const q = selectedQuote(t);
  if (!q || !q.eligible) { p.push(q?.reason ?? 'This plan is not available right now'); return p; }
  if (q.needsDelivery && !isAddressComplete(t.delivery)) p.push('Complete the delivery address (recipient, phone, address, floor/room)');
  if (!isAddressComplete(t.pickupAddr)) p.push('Complete the pickup address and contact details');
  const k = t.pickup;
  if (!k.method) p.push('Choose a return method');
  if (!isPickupDateValid(k.date)) p.push(k.method === 'store' ? 'Choose a valid drop-off date' : 'Choose a valid pickup date');
  if (k.method === 'courier') {
    if (!courierPickupSupported(t.pickupAddr)) p.push('Courier pickup is not available at this address; use drop-off instead');
    else if (!k.slot) p.push('Choose a pickup time slot');
    else if (k.date && !slotAvailable(k.date, k.slot)) p.push('That time slot is full; choose another');
  }
  if (k.method === 'store') {
    const sp = SERVICE_POINTS.find((s) => s.id === k.servicePointId);
    if (!sp) p.push('Choose a service point'); else if (!sp.supports.includes(t.planId)) p.push('That service point does not support this plan');
    else if (sp.appointment && !k.slot) p.push('This service point needs an appointment: choose a time slot');
    else { const ap = appointmentProblem(sp.id, k.date, k.slot); if (ap) p.push(`${ap}; choose another`); }
  }
  return p;
}
export function payloadOf(t: TaskState): SubmitPayload | null {
  if (readiness(t).length > 0) return null;
  const q = selectedQuote(t)!;
  return { orderId: t.orderId!, symptoms: [...t.symptoms], note: '', deadline: t.deadline!, departDate: t.departDate, planId: t.planId!,
    delivery: q.needsDelivery ? t.delivery : null, pickupAddr: t.pickupAddr, pickup: t.pickup, quoteFingerprint: fingerprint(q) };
}
/** Key of the confirmation card: any change to what would be submitted changes it. */
export const confirmKey = (t: TaskState): string => { const p = payloadOf(t); return p ? fingerprint(p) : 'not-ready'; };

// ---------- what is still missing ----------
export type Need = 'order' | 'symptoms' | 'deadline' | 'plan' | 'method' | 'location' | 'servicepoint' | 'dropdate' | 'pickup' | 'confirm';
/** The single next thing to ask for, given everything already known. Null when something else blocks (nothing to ask). */
export function nextNeed(t: TaskState): Need | null {
  if (!orderById(t.orderId)) return 'order';
  if (t.symptoms.length === 0) return 'symptoms';
  if (!t.deadline || !checkDeadline(t.deadline, t.departDate).ok) return 'deadline';
  if (!t.planId) return 'plan';
  const k = t.pickup;
  if (!k.method) return 'method';
  if (k.method === 'store') {
    const sp = SERVICE_POINTS.find((s) => s.id === k.servicePointId);
    if (!sp || !sp.supports.includes(t.planId)) return effectiveLocation(t) === null ? 'location' : 'servicepoint';
    if (!isPickupDateValid(k.date) || (sp.appointment && (!k.slot || appointmentProblem(sp.id, k.date, k.slot)))) return 'dropdate';   // appointment-only points also need a booked slot
  } else if (!isPickupDateValid(k.date) || !k.slot || !slotAvailable(k.date!, k.slot)) return 'pickup';
  return readiness(t).length === 0 ? 'confirm' : null;
}

// ---------- state updates (each returns a NEW state; unaffected information is kept) ----------
export function setOrder(t: TaskState, orderId: string): TaskState {
  const o = orderById(orderId);
  const keep = o && t.planId && eligibility(t.planId, o).eligible; // re-check eligibility when the item changes
  const next = { ...t, orderId, planId: keep ? t.planId : null };
  return keep ? next : { ...next, pickup: { ...t.pickup, servicePointId: null } };
}
export function setPlan(t: TaskState, planId: PlanId | null): TaskState {
  const sp = SERVICE_POINTS.find((s) => s.id === t.pickup.servicePointId);
  return { ...t, planId, pickup: { ...t.pickup, servicePointId: sp && planId && sp.supports.includes(planId) ? sp.id : null } };
}
export function setPickup(t: TaskState, patch: Partial<PickupState>): TaskState {
  const p = { ...t.pickup, ...patch };
  if (patch.method && patch.method !== t.pickup.method) { if (patch.method === 'courier') p.servicePointId = null; else p.slot = null; }
  if (p.date && p.slot && !slotAvailable(p.date, p.slot)) p.slot = null;
  if (p.slot && !PICKUP_SLOTS.includes(p.slot as (typeof PICKUP_SLOTS)[number])) p.slot = null;
  if (p.method === 'store' && p.slot && appointmentProblem(p.servicePointId, p.date, p.slot)) p.slot = null;   // a booked slot never survives a change that puts it outside opening hours
  return { ...t, pickup: p };
}
export const setDelivery = (t: TaskState, a: Address): TaskState => ({ ...t, delivery: a }); // never touches pickupAddr
/** Everything a message's interactive controls depend on. Controls stay actionable only while this is unchanged (stale ones are frozen). */
export const revisionOf = (t: TaskState): string => fingerprint([t.orderId, [...t.symptoms].sort(), t.deadline, t.departDate, t.planId, t.preference, t.locationPref, t.delivery.id, t.pickupAddr.id, t.pickup, t.submit.status]);
export const isLocked = (t: TaskState): boolean => t.submit.status === 'done';
export const PLAN_ORDER = PLAN_IDS;

/** Which saved company addresses exist: decides select / choose / fill. */
export function companyChoice(book: Address[]): { kind: 'none' } | { kind: 'one'; addr: Address } | { kind: 'many'; addrs: Address[] } {
  const c = book.filter((a) => a.kind === 'company');
  return c.length === 0 ? { kind: 'none' } : c.length === 1 ? { kind: 'one', addr: c[0] } : { kind: 'many', addrs: c };
}
export const supportedPoints = (t: TaskState) => (t.planId ? servicePointsFor(t.planId) : SERVICE_POINTS);

// ---------- messages and cards ----------
export type CardType = 'orders' | 'symptoms' | 'deadline' | 'plans' | 'address' | 'pickup' | 'servicepoints' | 'dropdate' | 'confirm' | 'receipt' | 'terms' | 'progress' | 'change' | 'compare';
export interface Card { type: CardType; snapshot: TaskState; mode?: 'single' | 'choose' | 'fill' | 'edit'; idemKey?: string; record?: CaseRecord; progress?: string[]; data?: unknown; ids?: string[] }   // data: a query result shown by a compare card; ids: restrict a service-point list
export type RMsg =
  | { id: string; role: 'user'; text: string; via: 'model' | 'rules_only' | 'rules_chosen' | 'failed' | 'pending' | 'action'; trace?: ClientTrace; from?: CardType }   // from: the card this answer came from; via/trace say HOW it was understood
  | { id: string; role: 'agent'; text: string; card?: Card; error?: boolean; quick?: QuickReply[]; answered?: boolean; memo?: string; lang?: { payload: LangPayload; snapshot: TaskState; requestId: string } }   // lang: a model-written interface with the state and facts it was written against, frozen   // memo: app-written summary of a what-if, kept for the model's history
  | { id: string; role: 'action'; text: string };

/** A suggested reply. `intent` runs through the same handler as typed language; `action` is for non-state buttons. */
export interface QuickReply { text: string; intent?: Intent; diff?: boolean; action?: 'progress' | 'replan' | 'retry' | 'use_rules'; payload?: { msgId: string; text: string; requestId: string } }

let seq = 0;
export const nextRid = (p: string): string => `${p}${++seq}`;

/** Cards that ask for one thing; they collapse into a one-line summary once that thing is known. */
export const ASKING: CardType[] = ['orders', 'symptoms', 'deadline', 'plans', 'servicepoints', 'dropdate', 'pickup'];
export const isReadOnlyCard = (c: Card): boolean => c.type === 'receipt' || c.type === 'terms' || c.type === 'progress' || c.type === 'change' || c.type === 'compare';
export function satisfied(type: CardType, t: TaskState): boolean {
  switch (type) {
    case 'orders': return !!orderById(t.orderId);
    case 'symptoms': return t.symptoms.length > 0;
    case 'deadline': return !!t.deadline && checkDeadline(t.deadline, t.departDate).ok;
    case 'plans': return !!t.planId;
    case 'servicepoints': { const sp = SERVICE_POINTS.find((s) => s.id === t.pickup.servicePointId); return !!sp && (!t.planId || sp.supports.includes(t.planId)); }
    case 'dropdate': { const sp = SERVICE_POINTS.find((s) => s.id === t.pickup.servicePointId); return isPickupDateValid(t.pickup.date) && (!sp?.appointment || (!!t.pickup.slot && !appointmentProblem(sp.id, t.pickup.date, t.pickup.slot))); }
    case 'pickup': return isPickupDateValid(t.pickup.date) && !!t.pickup.slot && slotAvailable(t.pickup.date!, t.pickup.slot);
    default: return false;
  }
}
/** After a state change, cards whose question is now answered (by typing OR by clicking) collapse. New cards are never touched. */
export function markAnswered(msgs: RMsg[], t: TaskState): RMsg[] {
  return msgs.map((m) => (m.role === 'agent' && m.card && !m.answered && ASKING.includes(m.card.type) && satisfied(m.card.type, t) ? { ...m, answered: true } : m));
}

/** Is this card still actionable? Otherwise it renders as a summary (answered) or frozen with an "Updated" badge. */
export function cardLive(msgs: RMsg[], index: number, t: TaskState): boolean {
  const m = msgs[index];
  if (m.role !== 'agent' || !m.card) return false;
  const c = m.card;
  if (isReadOnlyCard(c) || isLocked(t) || m.answered) return false;
  const later = msgs.slice(index + 1).filter((x) => x.role === 'agent' && x.card);
  if (later.some((x) => x.role === 'agent' && x.card?.type === c.type)) return false;           // only the newest card of a kind
  if (c.type === 'plans') return plansKey(c.snapshot) === plansKey(t);
  if (c.type === 'confirm') return confirmKey(c.snapshot) === confirmKey(t) && confirmKey(t) !== 'not-ready';
  if (c.type === 'address') return !msgs.slice(index + 1).some((x) => (x.role === 'user' && x.from !== 'address') || x.role === 'action'); // stays open through its own answers and the agent's follow-up; collapses once the user does something else
  return true;
}

// ---------- what changed between two states (reported after every state change, generic over the fields) ----------
const FIELD_LABELS: [string, (t: TaskState) => string | null][] = [
  ['Item', (t) => orderById(t.orderId)?.name ?? null],
  ['Problem', (t) => (t.symptoms.length ? t.symptoms.join(', ') : null)],
  ['Latest receive date', (t) => t.deadline],
  ['Departure date', (t) => t.departDate],
  ['Plan', (t) => t.planId],
  ['Delivery address', (t) => t.delivery.label],
  ['Pickup address', (t) => t.pickupAddr.label],
  ['Return method', (t) => (t.pickup.method === 'store' ? 'you drop it off' : t.pickup.method === 'courier' ? 'courier pickup' : null)],
  ['Service point', (t) => SERVICE_POINTS.find((s) => s.id === t.pickup.servicePointId)?.name ?? null],
  ['Pickup / drop-off date', (t) => t.pickup.date],
  ['Time slot', (t) => t.pickup.slot],
  ['Preference', (t) => t.preference],
  ['Search service points near', (t) => t.locationPref],
];
export function diffTask(a: TaskState, b: TaskState): { changed: { label: string; from: string; to: string }[]; kept: string[] } {
  const changed: { label: string; from: string; to: string }[] = [], kept: string[] = [];
  for (const [label, get] of FIELD_LABELS) {
    const x = get(a), y = get(b);
    if (x !== y) changed.push({ label, from: x ?? 'not set', to: y ?? 'not set' });
    else if (y !== null) kept.push(label);
  }
  return { changed, kept };
}

/** The application's own report of what a change did, shown to the user and given to the model (so it never has to guess). */
export function reportOf(a: TaskState, b: TaskState): string | null {
  const d = diffTask(a, b);
  return d.changed.length ? `Changed: ${d.changed.map((c) => `${c.label}: ${c.from} → ${c.to}`).join('; ')}.\nUnchanged: ${d.kept.join(', ') || 'nothing else was set'}.` : null;
}
