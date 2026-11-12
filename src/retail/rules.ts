/**
 * Business rules and the simulated quote service for the retail demo. Pure and deterministic: the same input always
 * gives the same quote. Fees, eligibility and dates come ONLY from here, never from model text.
 */
import { ORDERS, PICKUP_SLOTS, PLAN_IDS, PLAN_LABEL, RETAIL_TODAY, SERVICE_POINTS, STOCK, type Address, type Order, type PlanId, type SymptomId, type Zone } from './data.ts';

// ---------- dates (YYYY-MM-DD, UTC) ----------
const DAY = 86_400_000;
export const isIsoDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(Date.parse(s)).toISOString().slice(0, 10) === s;
export const addDays = (d: string, n: number): string => new Date(Date.parse(d) + n * DAY).toISOString().slice(0, 10);
export const diffDays = (a: string, b: string): number => Math.round((Date.parse(a) - Date.parse(b)) / DAY); // a - b
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dateText = (d: string): string => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
export const money = (cents: number): string => `¥${(cents / 100).toFixed(2)}`;
/** Whole calendar months between two dates (day-of-month aware). */
export function fullMonths(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number), [ty, tm, td] = to.split('-').map(Number);
  return Math.max(0, (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0));
}

// ---------- geography ----------
export function zoneOf(a: Pick<Address, 'x' | 'y'>): Zone {
  const d = Math.hypot(a.x - 50, a.y - 50);
  return d <= 20 ? 'urban' : d <= 35 ? 'suburb' : 'remote';
}
export const ZONE_LABEL: Record<Zone, string> = { urban: 'Urban', suburb: 'Suburban', remote: 'Remote' };
const SHIPPING_CENTS: Record<Zone, number> = { urban: 0, suburb: 1000, remote: 2500 };
const EXCHANGE_TRANSIT: Record<Zone, number> = { urban: 4, suburb: 5, remote: 8 };
const REPAIR_RETURN_TRANSIT: Record<Zone, number> = { urban: 2, suburb: 3, remote: 5 };
const REPAIR_PROCESSING_DAYS = 5, REPAIR_ARRIVE_DAYS = 1, REFUND_INSPECT_DAYS = 3, REFUND_PAY_DAYS = 3;
const SERVICE_FEE_OUT_OF_WARRANTY = 12900;

export function isAddressComplete(a: Address): boolean {
  return [a.recipient, a.phone, a.detail, a.floor].every((s) => s.trim().length > 0) && /^[0-9-]{7,15}$/.test(a.phone.trim());
}
export const orderById = (id: string | null | undefined): Order | undefined => ORDERS.find((o) => o.id === id);

// ---------- eligibility ----------
export interface Eligibility { eligible: boolean; reason?: string }
export function eligibility(plan: PlanId, order: Order, today = RETAIL_TODAY): Eligibility {
  const inWarranty = today <= order.warrantyEnd;
  if (plan === 'repair') return { eligible: true };
  if (!inWarranty) return { eligible: false, reason: `Out of warranty (expired ${order.warrantyEnd})` };
  if (plan === 'exchange' && (STOCK[order.sku] ?? 0) <= 0) return { eligible: false, reason: 'Out of stock, so exchange is not possible' };
  return { eligible: true };
}

// ---------- pickup availability ----------
export const earliestPickup = (today = RETAIL_TODAY): string => addDays(today, 1);
export const latestPickup = (today = RETAIL_TODAY): string => addDays(today, 7);
export const isPickupDateValid = (d: string | null, today = RETAIL_TODAY): boolean => isIsoDate(d) && d >= earliestPickup(today) && d <= latestPickup(today);
/** Deterministic availability: a slot is full when (day-of-month + slot index) is divisible by 5. */
export function slotAvailable(date: string, slot: string): boolean {
  const i = PICKUP_SLOTS.indexOf(slot as (typeof PICKUP_SLOTS)[number]);
  return i >= 0 && (Number(date.slice(8, 10)) + i) % 5 !== 0;
}
export const availableSlots = (date: string): string[] => (isPickupDateValid(date) ? PICKUP_SLOTS.filter((s) => slotAvailable(date, s)) : []);
const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** Is the whole slot inside "HH:MM-HH:MM" opening hours? An appointment can never start before opening or end after closing. */
export function slotWithinHours(slot: string, hours: string): boolean {
  const [s0, s1] = slot.split('-'), [h0, h1] = hours.split('-');
  return !!(s0 && s1 && h0 && h1) && minutes(s0) >= minutes(h0) && minutes(s1) <= minutes(h1);
}
/** Why a drop-off appointment slot cannot be booked, or null when it can. Walk-in points take no slot. */
export function appointmentProblem(spId: string | null | undefined, date: string | null, slot: string | null): string | null {
  const sp = SERVICE_POINTS.find((s) => s.id === spId);
  if (!sp || !sp.appointment || !slot) return null;
  if (!slotWithinHours(slot, sp.hours)) return `${slot} is outside ${sp.name} opening hours (${sp.hours})`;
  if (date && !slotAvailable(date, slot)) return `${slot} is full on that day`;
  return null;
}
/** Slots offered for a store appointment: only those inside opening hours, each with whether it is still free that day. */
export const appointmentSlots = (spId: string, date: string | null): { slot: string; ok: boolean; why: string | null }[] => {
  const sp = SERVICE_POINTS.find((s) => s.id === spId);
  return PICKUP_SLOTS.filter((s) => !sp || slotWithinHours(s, sp.hours)).map((s) => { const full = !!date && !slotAvailable(date, s); return { slot: s, ok: !full, why: full ? 'Full' : null }; });
};
/** Normalise a stated time range ("14:00-18:00", "2pm to 6pm", "14:00–18:00") to one of the bookable slots, or null. */
export function normaliseSlot(text: string): string | null {
  const m = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  const h = (n: string, mi: string | undefined, ap: string | undefined, other?: string) => { let x = Number(n); const a = (ap ?? other)?.toLowerCase(); if (a === 'pm' && x < 12) x += 12; if (a === 'am' && x === 12) x = 0; return `${String(x).padStart(2, '0')}:${mi ?? '00'}`; };
  const slot = `${h(m[1], m[2], m[3], m[6])}-${h(m[4], m[5], m[6], m[3])}`;
  return (PICKUP_SLOTS as readonly string[]).includes(slot) ? slot : null;
}
export const courierPickupSupported = (a: Pick<Address, 'x' | 'y'>): boolean => zoneOf(a) !== 'remote';
export const servicePointsFor = (plan: PlanId) => SERVICE_POINTS.filter((p) => p.supports.includes(plan));
export const servicePointById = (id: string | null | undefined) => SERVICE_POINTS.find((p) => p.id === id);
/** Schematic distance for the demo map (1 map unit = 0.5 km). */
export const distanceKm = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.round(Math.hypot(a.x - b.x, a.y - b.y) * 5) / 10;

// ---------- quote ----------
export type Timing = 'on_time' | 'late' | 'unknown' | 'no_device';
export interface PlanQuote {
  plan: PlanId; eligible: boolean; reason?: string;
  fees: { serviceCents: number; shippingCents: number; totalCents: number; refundCents: number | null };
  steps: { label: string; date: string }[];
  etaDate: string | null; etaLabel: string; timing: Timing; marginDays: number | null;
  pickupAssumed: boolean; needsDelivery: boolean;
}
export interface QuoteInput { orderId: string | null; deadline: string | null; delivery: Address; pickupDate: string | null; method?: 'courier' | 'store' | null }

export function quotePlan(plan: PlanId, input: QuoteInput, today = RETAIL_TODAY): PlanQuote | null {
  const order = orderById(input.orderId);
  if (!order) return null;
  const el = eligibility(plan, order, today);
  const inWarranty = today <= order.warrantyEnd;
  const zone = zoneOf(input.delivery);
  const pickupAssumed = !isPickupDateValid(input.pickupDate, today);
  const pickup = pickupAssumed ? earliestPickup(today) : input.pickupDate!;
  const needsDelivery = plan !== 'refund';
  const dropOff = input.method === 'store';           // the customer takes the old unit to a service point: nobody "picks it up"
  const handover = dropOff ? 'you drop off the old unit' : 'old unit picked up';
  const base = { plan, eligible: el.eligible, reason: el.reason, pickupAssumed, needsDelivery };
  const none = { fees: { serviceCents: 0, shippingCents: 0, totalCents: 0, refundCents: null }, steps: [], etaDate: null, etaLabel: plan === 'refund' ? 'Estimated refund arrival' : 'Estimated delivery', timing: 'unknown' as Timing, marginDays: null };
  if (!el.eligible) return { ...base, ...none };

  let serviceCents = 0, shippingCents = 0, refundCents: number | null = null, steps: { label: string; date: string }[] = [], eta: string;
  if (plan === 'exchange') {
    shippingCents = SHIPPING_CENTS[zone];
    const dispatch = addDays(today, 1);
    eta = addDays(dispatch, EXCHANGE_TRANSIT[zone]);
    steps = [{ label: 'replacement ships', date: dispatch }, { label: 'estimated delivery', date: eta }, { label: handover, date: pickup }];
  } else if (plan === 'repair') {
    serviceCents = inWarranty ? 0 : SERVICE_FEE_OUT_OF_WARRANTY;
    shippingCents = inWarranty ? 0 : SHIPPING_CENTS[zone]; // in warranty the service centre pays the return shipping
    const arrive = addDays(pickup, REPAIR_ARRIVE_DAYS), done = addDays(arrive, REPAIR_PROCESSING_DAYS);
    eta = addDays(done, REPAIR_RETURN_TRANSIT[zone]);
    steps = [{ label: dropOff ? 'you drop it off' : 'pickup', date: pickup }, { label: 'arrives at repair center', date: arrive }, { label: 'repair done', date: done }, { label: 'estimated delivery', date: eta }];
  } else {
    const deduct = Math.round((order.priceCents * Math.min(40, 5 * fullMonths(order.purchased, today))) / 100);
    refundCents = order.priceCents - deduct;
    const arrive = addDays(pickup, REFUND_ARRIVE());
    const inspected = addDays(arrive, REFUND_INSPECT_DAYS);
    eta = addDays(inspected, REFUND_PAY_DAYS);
    steps = [{ label: dropOff ? 'you drop it off' : 'pickup', date: pickup }, { label: 'received and inspected', date: inspected }, { label: 'estimated refund arrival', date: eta }];
  }
  const margin = input.deadline ? diffDays(input.deadline, eta) : null;
  const timing: Timing = plan === 'refund' ? 'no_device' : !input.deadline ? 'unknown' : eta <= input.deadline ? 'on_time' : 'late';
  return { ...base, fees: { serviceCents, shippingCents, totalCents: serviceCents + shippingCents, refundCents }, steps, etaDate: eta, etaLabel: plan === 'refund' ? 'Estimated refund arrival' : 'Estimated delivery', timing, marginDays: margin };
}
const REFUND_ARRIVE = () => 1;

/** Plain wording for deadline minus estimated arrival. Zero spare days is "on the deadline day", never "before". */
export const marginText = (m: number): string => (m > 0 ? `arrives in time, ${m} day${m === 1 ? '' : 's'} before your deadline` : m === 0 ? 'arrives on your deadline day' : `misses your deadline by ${-m} day${m === -1 ? '' : 's'}`);

export function quoteAll(input: QuoteInput, today = RETAIL_TODAY): PlanQuote[] {
  return PLAN_IDS.map((p) => quotePlan(p, input, today)).filter((q): q is PlanQuote => q !== null);
}

// ---------- recommendation ----------
export type Preference = 'fastest' | 'cheapest';
export interface Recommendation { planId: PlanId | null; text: string }
export function recommend(quotes: PlanQuote[], deadline: string | null, preference: Preference | null): Recommendation {
  if (!deadline) return { planId: null, text: 'The latest receive date is not confirmed yet, so I cannot tell which plan arrives in time.' };
  const dl = dateText(deadline);
  const ok = quotes.filter((q) => q.eligible && q.timing === 'on_time');
  const others = quotes.filter((q) => q.eligible && q.plan !== 'refund' && q.timing === 'late')
    .map((q) => `${PLAN_LABEL[q.plan]} is estimated to arrive ${dateText(q.etaDate!)}, after ${dl}`);
  if (ok.length === 0) {
    const refund = quotes.find((q) => q.plan === 'refund' && q.eligible);
    const parts = [`No plan can get you a working device by ${dl}, so I am not recommending one. `, ...others.map((s) => `${s}. `)];
    if (refund) parts.push(`The refund is estimated to arrive ${dateText(refund.etaDate!)}, but it cannot provide a working device.`);
    return { planId: null, text: parts.join('').trim() };
  }
  const pick = [...ok].sort((a, b) => preference === 'fastest'
    ? a.etaDate!.localeCompare(b.etaDate!) || a.fees.totalCents - b.fees.totalCents
    : a.fees.totalCents - b.fees.totalCents || a.etaDate!.localeCompare(b.etaDate!))[0];
  const why = preference === 'fastest' ? ' (picked for "Fastest first")' : preference === 'cheapest' ? ' (picked for "Lowest cost first")' : '';
  const alsoOk = ok.filter((q) => q !== pick).map((q) => `${PLAN_LABEL[q.plan]} would also make it (estimated ${dateText(q.etaDate!)}, cost ${money(q.fees.totalCents)})`);
  const text = [`Recommended: ${PLAN_LABEL[pick.plan]}${why}. Estimated delivery ${dateText(pick.etaDate!)}, ${pick.etaDate === deadline ? `on your ${dl} deadline day` : `before your ${dl} deadline`}, cost ${money(pick.fees.totalCents)}. `,
    ...[...alsoOk, ...others].map((s) => `${s}. `), 'A refund arriving does not mean you have working headphones, so it is not offered as a fix for the trip.'].join('');
  return { planId: pick.plan, text };
}

// ---------- validation helpers ----------
export type DateCheck = { ok: true } | { ok: false; message: string };
export function checkDeadline(deadline: string, departDate: string | null, today = RETAIL_TODAY): DateCheck {
  if (!isIsoDate(deadline)) return { ok: false, message: 'The latest receive date is not a valid date.' };
  if (deadline <= today) return { ok: false, message: `The latest receive date must be after today (${today}).` };
  if (departDate && deadline > departDate) return { ok: false, message: `The latest receive date cannot be after the departure date (${departDate}).` };
  return { ok: true };
}
export function checkDepart(depart: string, today = RETAIL_TODAY): DateCheck {
  if (!isIsoDate(depart)) return { ok: false, message: 'The departure date is not a valid date.' };
  if (depart <= today) return { ok: false, message: `The departure date must be after today (${today}).` };
  return { ok: true };
}

/** Stable short fingerprint of any JSON-able value (FNV-1a). Used for quote versions and card staleness. */
export function fingerprint(v: unknown): string {
  const s = JSON.stringify(v); let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
export const symptomLabel = (ids: SymptomId[], all: { id: SymptomId; label: string }[]): string => ids.map((i) => all.find((s) => s.id === i)?.label ?? i).join(', ');
