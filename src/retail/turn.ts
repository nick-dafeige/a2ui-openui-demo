/**
 * Turn planner (v0.4.0). The model does not just label the message: it reads the task state and a bundle of business FACTS,
 * decides whether this turn is a discussion, a what-if or a state change, may ask the application to run read-only business
 * tools, and chooses which registered components to show. The application stays the only source of numbers, eligibility,
 * logistics and state: figures in the model's wording must exist in the facts or tool results (`guardAnswer`), hypothetical
 * turns never change state, and nothing is submitted from here. Pure and browser-safe; the model call is injected.
 */
import { ORDERS, PLAN_IDS, PLAN_LABEL, PLAN_TERMS, RETAIL_TODAY, SERVICE_POINTS, SYMPTOMS, type Address, type PlanId } from './data.ts';
import { validateIntent, type Intent } from './intent.ts';
import { addDays, dateText, diffDays, distanceKm, earliestPickup, isIsoDate, isPickupDateValid, latestPickup, marginText, money, orderById, quoteAll, recommend, ZONE_LABEL, zoneOf, type PlanQuote, type Timing } from './rules.ts';
import type { LangPayload } from './openui/compose.ts';
import { candidateOrders, companyChoice, effectiveLocation, isLocked, locationAddress, nextNeed, quoteInput, quotesOf, type Need, type TaskState } from './state.ts';

// ======================= tools (read-only, deterministic) =======================
export type ToolName = 'quote_plans' | 'service_points' | 'policy_terms';
export interface Query { id: string; tool: ToolName; args: Record<string, unknown> }

export interface QuoteRow {
  plan: PlanId; label: string; eligible: boolean; reason: string | null;
  etaNow: string | null; etaNowDate: string | null; etaAlt: string | null; etaAltDate: string | null; etaLabel: string;
  deltaDays: number | null;                 // alternative minus now; negative = earlier
  totalNow: string; totalNowCents: number; totalAlt: string; totalAltCents: number; deltaCents: number;
  refund: string | null; refundCents: number | null;
  timingNow: Timing; timingAlt: Timing; marginAltDays: number | null;   // deadline minus ETA under the alternative
}
export interface QuoteResult {
  id: string; tool: 'quote_plans'; assumptions: string[]; deadline: string | null; deadlineText: string | null;
  applyIntent: Intent | null;               // derived from the overrides, so "apply this" never depends on model wording
  rows: QuoteRow[];
}
export interface PointRow { id: string; name: string; detail: string; hours: string; appointment: boolean; supports: PlanId[]; supportsPlan: boolean | null; distanceKm: number; rank: number }
export interface PointsResult { id: string; tool: 'service_points'; near: 'company' | 'home'; nearLabel: string; plan: PlanId | null; points: PointRow[] }
export interface TermsResult { id: string; tool: 'policy_terms'; terms: { plan: PlanId; label: string; lines: string[] }[] }
export interface ErrorResult { id: string; tool: ToolName; error: string }
export type QueryResult = QuoteResult | PointsResult | TermsResult | ErrorResult;
export type GoodResult = QuoteResult | PointsResult | TermsResult;
export const isGood = (r: QueryResult): r is GoodResult => !('error' in r);

const QUOTE_ARGS = ['delivery', 'deadline', 'deadlineShiftDays', 'pickupDate', 'method', 'plan'];
const POINT_ARGS = ['ids', 'near', 'plan'];
const TERMS_ARGS = ['plan'];

/** Validate a model-declared query. The model proposes, the application decides what runs. */
export function validateQuery(q: unknown, seen: Set<string>): { ok: true; query: Query } | { ok: false; reason: string } {
  if (typeof q !== 'object' || q === null) return { ok: false, reason: 'query_not_object' };
  const r = q as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^q[1-9]$/.test(r.id) || seen.has(r.id)) return { ok: false, reason: 'bad_query_id' };
  if (r.tool !== 'quote_plans' && r.tool !== 'service_points' && r.tool !== 'policy_terms') return { ok: false, reason: 'unknown_tool' };
  const args = (r.args ?? {}) as Record<string, unknown>;
  if (typeof args !== 'object' || Array.isArray(args)) return { ok: false, reason: 'bad_args' };
  const allowed = r.tool === 'quote_plans' ? QUOTE_ARGS : r.tool === 'service_points' ? POINT_ARGS : TERMS_ARGS;
  for (const k of Object.keys(args)) if (!allowed.includes(k)) return { ok: false, reason: `unknown_arg:${k}` };
  if (args.plan !== undefined && !PLAN_IDS.includes(args.plan as PlanId)) return { ok: false, reason: 'bad_plan' };
  for (const k of ['deadline', 'pickupDate']) if (args[k] !== undefined && !isIsoDate(args[k])) return { ok: false, reason: `bad_${k}` };
  if (args.deadlineShiftDays !== undefined && !(Number.isInteger(args.deadlineShiftDays) && Math.abs(args.deadlineShiftDays as number) <= 30)) return { ok: false, reason: 'bad_deadlineShiftDays' };
  if (args.deadline !== undefined && args.deadlineShiftDays !== undefined) return { ok: false, reason: 'deadline_and_shift_together' };
  if (args.method !== undefined && args.method !== 'courier' && args.method !== 'store') return { ok: false, reason: 'bad_method' };
  if (args.delivery !== undefined && typeof args.delivery !== 'string') return { ok: false, reason: 'bad_delivery' };
  if (args.near !== undefined && args.near !== 'company' && args.near !== 'home') return { ok: false, reason: 'bad_near' };
  if (args.ids !== undefined && !(Array.isArray(args.ids) && args.ids.length <= 3 && args.ids.every((i) => SERVICE_POINTS.some((s) => s.id === i)))) return { ok: false, reason: 'bad_ids' };
  seen.add(r.id);
  return { ok: true, query: { id: r.id, tool: r.tool, args } };
}

const addrLabel = (a: Address) => `${a.label} (${ZONE_LABEL[zoneOf(a)]})`;
function resolveDelivery(t: TaskState, v: string): { addr: Address } | { error: string } {
  if (v === 'current') return { addr: t.delivery };
  const byId = t.book.find((a) => a.id === v);
  if (byId) return { addr: byId };
  if (v === 'home') { const h = t.book.find((a) => a.kind === 'home'); return h ? { addr: h } : { error: 'no_home_address_saved' }; }
  if (v === 'company') {
    const c = companyChoice(t.book);
    return c.kind === 'one' ? { addr: c.addr } : c.kind === 'none' ? { error: 'no_company_address_saved' } : { error: `several_company_addresses:${c.addrs.map((a) => a.id).join(',')}` };
  }
  return { error: 'unknown_delivery_address' };
}

export function runQuery(q: Query, t: TaskState): QueryResult {
  const a = q.args;
  if (q.tool === 'policy_terms') {
    const plans = a.plan ? [a.plan as PlanId] : PLAN_IDS;
    return { id: q.id, tool: 'policy_terms', terms: plans.map((p) => ({ plan: p, label: PLAN_LABEL[p], lines: PLAN_TERMS[p] })) };
  }
  if (q.tool === 'service_points') {
    const loc = (a.near as 'company' | 'home' | undefined) ?? (t.locationPref ?? (t.book.some((x) => x.kind === 'company') ? 'company' : 'home'));
    const from = t.book.find((x) => x.kind === loc) ?? t.delivery;
    const plan = (a.plan as PlanId | undefined) ?? t.planId;
    const ids = a.ids as string[] | undefined;
    const sorted = [...SERVICE_POINTS].sort((x, y) => distanceKm(x, from) - distanceKm(y, from));
    const points = sorted.map((s, i): PointRow => ({ id: s.id, name: s.name, detail: s.detail, hours: s.hours, appointment: s.appointment, supports: s.supports, supportsPlan: plan ? s.supports.includes(plan) : null, distanceKm: distanceKm(s, from), rank: i + 1 }))
      .filter((p) => !ids || ids.includes(p.id));
    return { id: q.id, tool: 'service_points', near: loc, nearLabel: from.label, plan: plan ?? null, points };
  }
  // quote_plans: what the plans would look like under some overrides, next to what they are now
  const base = quoteInput(t);
  const assumptions: string[] = []; const alt = { ...base };
  let apply: Intent = {};
  if (typeof a.delivery === 'string') {
    const d = resolveDelivery(t, a.delivery);
    if ('error' in d) return { id: q.id, tool: 'quote_plans', error: d.error };
    alt.delivery = d.addr; assumptions.push(`delivery to ${addrLabel(d.addr)}`);
    if (d.addr.kind === 'home' || d.addr.kind === 'company') apply.deliveryTarget = d.addr.kind;
  }
  if (typeof a.deadlineShiftDays === 'number') {
    if (!base.deadline) return { id: q.id, tool: 'quote_plans', error: 'no_current_deadline_to_shift' };
    const shifted = addDays(base.deadline, a.deadlineShiftDays);
    if (shifted <= RETAIL_TODAY) return { id: q.id, tool: 'quote_plans', error: `shifted_deadline_${shifted}_is_not_after_today` };
    alt.deadline = shifted; assumptions.push(`latest receive date ${dateText(shifted)} (${Math.abs(a.deadlineShiftDays)} day${Math.abs(a.deadlineShiftDays) === 1 ? '' : 's'} ${a.deadlineShiftDays < 0 ? 'earlier' : 'later'})`); apply.deadline = shifted;
  } else if (typeof a.deadline === 'string') { alt.deadline = a.deadline; assumptions.push(`latest receive date ${dateText(a.deadline)}`); apply.deadline = a.deadline; }
  if (typeof a.pickupDate === 'string') {
    if (!isPickupDateValid(a.pickupDate)) return { id: q.id, tool: 'quote_plans', error: `pickup_date_outside_${earliestPickup()}_${latestPickup()}` };
    alt.pickupDate = a.pickupDate; assumptions.push(`${base.method === 'store' ? 'drop-off' : 'pickup'} on ${dateText(a.pickupDate)}`); apply.pickupDate = a.pickupDate;
  }
  if (a.method === 'courier' || a.method === 'store') { alt.method = a.method; assumptions.push(a.method === 'store' ? 'you drop the old unit off' : 'courier pickup'); apply.returnMethod = a.method; }
  if (!base.orderId) return { id: q.id, tool: 'quote_plans', error: 'no_item_chosen_yet' };
  const now = quoteAll(base), then = quoteAll(alt);
  const rows = (then.map((x): QuoteRow | null => {
    const n = now.find((y) => y.plan === x.plan);
    if (!n || (a.plan && a.plan !== x.plan)) return null;
    const refundNow = n.fees.refundCents, refundAlt = x.fees.refundCents;
    return {
      plan: x.plan, label: PLAN_LABEL[x.plan], eligible: x.eligible, reason: x.reason ?? null,
      etaNow: n.etaDate ? dateText(n.etaDate) : null, etaNowDate: n.etaDate, etaAlt: x.etaDate ? dateText(x.etaDate) : null, etaAltDate: x.etaDate, etaLabel: x.etaLabel,
      deltaDays: n.etaDate && x.etaDate ? diffDays(x.etaDate, n.etaDate) : null,
      totalNow: money(n.fees.totalCents), totalNowCents: n.fees.totalCents, totalAlt: money(x.fees.totalCents), totalAltCents: x.fees.totalCents, deltaCents: x.fees.totalCents - n.fees.totalCents,
      refund: refundAlt != null ? money(refundAlt) : null, refundCents: refundAlt ?? refundNow ?? null,
      timingNow: n.timing, timingAlt: x.timing, marginAltDays: alt.deadline && x.etaDate ? diffDays(alt.deadline, x.etaDate) : null,
    };
  }).filter((r): r is QuoteRow => r !== null));
  return { id: q.id, tool: 'quote_plans', assumptions: assumptions.length ? assumptions : ['nothing changed (current settings)'], deadline: alt.deadline, deadlineText: alt.deadline ? dateText(alt.deadline) : null, applyIntent: Object.keys(apply).length ? apply : null, rows };
}
export const runQueries = (qs: Query[], t: TaskState): QueryResult[] => qs.map((q) => runQuery(q, t));

// ======================= facts bundle =======================
export interface Allowed { cents: Set<number>; dates: Set<string>; ints: Set<number>; km: Set<number> }
export const newAllowed = (): Allowed => ({ cents: new Set(), dates: new Set(), ints: new Set(), km: new Set() });

/** Walk any JSON-able value and register every figure the application computed (by key name convention). */
export function collectAllowed(v: unknown, into: Allowed, key = ''): Allowed {
  if (typeof v === 'number') {
    if (/cents$/i.test(key)) into.cents.add(Math.abs(v));
    else if (/km$/i.test(key)) into.km.add(Math.abs(v));
    else if (/days?$/i.test(key) || /^rank$/i.test(key)) into.ints.add(Math.abs(v));
  } else if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) into.dates.add(v);
    if (/terms|lines/i.test(key)) addNumbersFromText(v, into);
  } else if (Array.isArray(v)) v.forEach((x) => collectAllowed(x, into, key));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) collectAllowed(x, into, k);
  return into;
}
export function addNumbersFromText(text: string, into: Allowed) {
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) { const n = Number(m[0]); into.ints.add(n); into.cents.add(Math.round(n * 100)); }
  for (const m of text.matchAll(new RegExp(MON_RE, 'gi'))) { const d = monthDay(m[1], Number(m[2])); if (d) into.dates.add(d); }
}
const MON_RE = String.raw`\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})\b`;   // whole month names only: "margin 0" is not a date
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthDay = (mon: string, day: number): string | null => { const m = MONTHS.indexOf(mon.toLowerCase().slice(0, 3)) + 1; const iso = `${RETAIL_TODAY.slice(0, 4)}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`; return m > 0 && isIsoDate(iso) ? iso : null; };

const quoteBrief = (q: PlanQuote, now?: PlanQuote) => ({
  plan: q.plan, available: q.eligible, reason: q.reason ?? null,
  eta: q.etaDate ? dateText(q.etaDate) : null, etaDate: q.etaDate, etaMeaning: q.etaLabel, timing: q.timing, marginDays: q.marginDays,
  shipping: money(q.fees.shippingCents), shippingCents: q.fees.shippingCents, serviceFee: money(q.fees.serviceCents), serviceCents: q.fees.serviceCents, total: money(q.fees.totalCents), totalCents: q.fees.totalCents,
  refund: q.fees.refundCents != null ? money(q.fees.refundCents) : null, refundCents: q.fees.refundCents,
  steps: q.steps.map((s) => ({ what: s.label, date: s.date })),
  ...(now && q.etaDate && now.etaDate ? { deltaDays: diffDays(q.etaDate, now.etaDate), deltaCents: q.fees.totalCents - now.fees.totalCents } : {}),
});

/** Everything the model may quote, pre-formatted. Generic: current plans, every saved delivery address, every service point, policy. */
export function buildFacts(t: TaskState): { text: string; allowed: Allowed; state: unknown } {
  const order = orderById(t.orderId);
  const now = quotesOf(t);
  const state = {
    today: RETAIL_TODAY,
    item: order ? { name: order.name, id: order.id, warrantyEnd: order.warrantyEnd, inWarranty: RETAIL_TODAY <= order.warrantyEnd } : null,
    symptoms: t.symptoms.map((s) => SYMPTOMS.find((x) => x.id === s)?.label ?? s),
    latestReceiveDate: t.deadline, departureDate: t.departDate, chosenPlan: t.planId, preference: t.preference,
    deliveryAddress: { id: t.delivery.id, label: t.delivery.label, zone: ZONE_LABEL[zoneOf(t.delivery)] },
    pickupAddress: { id: t.pickupAddr.id, label: t.pickupAddr.label },
    returnMethod: t.pickup.method, serviceCenterOrPoint: t.pickup.servicePointId, dropOffOrPickupDate: t.pickup.date, slot: t.pickup.slot, searchNear: t.locationPref,
    submitted: isLocked(t),
  };
  const need = nextNeed(t);
  const loc = effectiveLocation(t);
  // what the user is looking at and what the agent is waiting for: needed to resolve "the first one", "the Lite", "that store"
  const pending = {
    agentIsWaitingFor: need as Need | null,
    meaning: { order: 'the user must pick one of ordersShownToUser', symptoms: 'what is wrong with the item', deadline: 'the latest day the user needs a working device', plan: 'exchange, repair or refund', method: 'courier pickup or the user dropping the old unit off', location: 'service points near the company or near home', servicepoint: 'pick one of servicePointsShownToUser', dropdate: 'a drop-off date (and a slot if the point needs an appointment)', pickup: 'a courier date and slot', confirm: 'the user can press Confirm and submit' }[need ?? 'confirm'] ?? null,
    ordersShownToUser: need === 'order' ? candidateOrders(t).map((o, i) => ({ position: i + 1, id: o.id, name: o.name, inWarranty: RETAIL_TODAY <= o.warrantyEnd })) : null,
    servicePointsShownToUser: need === 'servicepoint' ? [...SERVICE_POINTS].filter((x) => !t.planId || x.supports.includes(t.planId)).sort((a, b) => distanceKm(a, locationAddress(t, loc ?? 'home')) - distanceKm(b, locationAddress(t, loc ?? 'home'))).map((x, i) => ({ position: i + 1, id: x.id, name: x.name })) : null,
  };
  const facts = {
    savedAddresses: t.book.map((a) => ({ id: a.id, label: a.label, zone: ZONE_LABEL[zoneOf(a)] })),
    plansWithCurrentSettings: now.map((q) => quoteBrief(q)),
    plansIfDeliveredElsewhere: t.orderId ? t.book.filter((a) => a.id !== t.delivery.id).map((a) => ({
      address: { id: a.id, label: a.label, zone: ZONE_LABEL[zoneOf(a)] },
      plans: quoteAll({ ...quoteInput(t), delivery: a }).map((q) => quoteBrief(q, now.find((n) => n.plan === q.plan))),
    })) : [],
    servicePoints: SERVICE_POINTS.map((s) => ({ id: s.id, name: s.name, hours: s.hours, appointmentRequired: s.appointment, handles: s.supports,
      distanceFromHomeKm: distanceKm(s, t.book.find((a) => a.kind === 'home') ?? t.delivery), distanceFromCompanyKm: t.book.some((a) => a.kind === 'company') ? distanceKm(s, t.book.find((a) => a.kind === 'company')!) : null })),
    pickupAndDropOffWindow: { from: earliestPickup(), to: latestPickup() },
    recommendationRule: recommend(now, t.deadline, t.preference).text,
    policyTerms: Object.fromEntries(PLAN_IDS.map((p) => [PLAN_LABEL[p], PLAN_TERMS[p]])),
  };
  const allowed = collectAllowed(facts, newAllowed()); collectAllowed(state, allowed);
  addNumbersFromText(JSON.stringify(facts.policyTerms), allowed);
  for (const o of ORDERS) allowed.dates.add(o.purchased);
  return { text: JSON.stringify({ STATE: state, PENDING: pending, FACTS: facts }), allowed, state };
}

// ======================= the model's plan =======================
export type Mode = 'discuss' | 'what_if' | 'change';
export type UiComponent = 'compare' | 'plans' | 'servicepoints' | 'address' | 'deadline' | 'orders' | 'symptoms' | 'dropdate' | 'pickup' | 'terms';
export interface UiItem { component: UiComponent; query?: string; ids?: string[]; mode?: 'edit' }
export interface QuickChoice { text: string; changes: Intent }
export interface TurnPlan { mode: Mode; changes: Intent; queries: Query[]; answer: string; ui: UiItem[]; quick: QuickChoice[]; ignoredChanges: boolean; droppedQuick: number }
const UI_COMPONENTS: UiComponent[] = ['compare', 'plans', 'servicepoints', 'address', 'deadline', 'orders', 'symptoms', 'dropdate', 'pickup', 'terms'];
const PLAN_KEYS = ['mode', 'changes', 'queries', 'answer', 'ui', 'quick'];

/** Obviously equivalent spellings are accepted, e.g. a saved address id or "House" for deliveryTarget; everything else stays strict. */
export function normaliseIntentRaw(raw: unknown, task?: TaskState): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const r = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(r.symptoms)) r.symptoms = r.symptoms.map((x) => { if (typeof x !== 'string') return x; const w = x.trim().toLowerCase().replace(/[\s-]+/g, '_'); const hit = SYMPTOMS.find((m) => m.id === w || m.label.toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, '') === w.replace(/[^a-z_]/g, '')); return hit ? hit.id : /(one_side|left|right).*(silent|sound|mute|dead)|(silent|no_sound).*(left|right|side)/.test(w) ? 'one_side_silent' : /(power|turn).*on|no_power|dead_battery/.test(w) ? 'no_power' : /charg/.test(w) ? 'charging' : x; });
  for (const k of ['deliveryTarget', 'locationPref']) {
    const v = r[k];
    if (typeof v !== 'string') continue;
    const byId = task?.book.find((a) => a.id === v);
    const w = v.trim().toLowerCase();
    r[k] = byId ? (byId.kind === 'custom' ? v : byId.kind) : /^(home|house|my home|my house)$/.test(w) ? 'home' : /^(company|office|work|my company|my office)$/.test(w) ? 'company' : v;
  }
  return r;
}

function parseUiAndQuick(r: Record<string, unknown>, queryIds: Set<string>, task?: TaskState): { ok: true; ui: UiItem[]; quick: QuickChoice[]; dropped: number } | { ok: false; reason: string } {
  const ui: UiItem[] = [];
  if (r.ui !== undefined) {
    if (!Array.isArray(r.ui) || r.ui.length > 3) return { ok: false, reason: 'bad_ui' };
    for (const u of r.ui as Record<string, unknown>[]) {
      if (typeof u !== 'object' || u === null || !UI_COMPONENTS.includes(u.component as UiComponent)) return { ok: false, reason: 'unknown_component' };
      for (const k of Object.keys(u)) if (!['component', 'query', 'ids', 'mode'].includes(k)) return { ok: false, reason: `unknown_ui_key:${k}` };
      const item: UiItem = { component: u.component as UiComponent };
      if (u.component === 'compare') { if (typeof u.query !== 'string' || !queryIds.has(u.query)) return { ok: false, reason: 'compare_needs_a_declared_query' }; item.query = u.query; }
      if (u.ids !== undefined) { if (u.component !== 'servicepoints' || !Array.isArray(u.ids) || !u.ids.every((i) => SERVICE_POINTS.some((s) => s.id === i))) return { ok: false, reason: 'bad_ids' }; item.ids = u.ids as string[]; }
      if (u.mode !== undefined) { if (u.component !== 'address' || u.mode !== 'edit') return { ok: false, reason: 'bad_ui_mode' }; item.mode = 'edit'; }
      ui.push(item);
    }
  }
  const quick: QuickChoice[] = []; let dropped = 0;
  if (r.quick !== undefined) {
    if (!Array.isArray(r.quick) || r.quick.length > 6) return { ok: false, reason: 'bad_quick' };
    for (const q of (r.quick as Record<string, unknown>[]).slice(0, 6)) {
      // a suggested button is optional: an invalid one is dropped (and counted) instead of discarding a good answer; state-changing `changes` stay strict
      const v = typeof q === 'object' && q !== null && typeof q.text === 'string' && q.text.length >= 1 && q.text.length <= 48 ? validateIntent(normaliseIntentRaw(q.changes ?? {}, task)) : null;
      if (!v || !v.ok || quick.length >= 3) { dropped++; continue; }
      quick.push({ text: (q as { text: string }).text, changes: v.intent });
    }
  }
  return { ok: true, ui, quick, dropped };
}

export function parseTurnPlan(raw: unknown, task?: TaskState): { ok: true; plan: TurnPlan } | { ok: false; reason: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'not_object' };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!PLAN_KEYS.includes(k)) return { ok: false, reason: `unknown_key:${k}` };
  if (r.mode !== 'discuss' && r.mode !== 'what_if' && r.mode !== 'change') return { ok: false, reason: 'bad_mode' };
  if (r.answer !== undefined && (typeof r.answer !== 'string' || r.answer.length > 1500)) return { ok: false, reason: 'bad_answer' };
  const qs: Query[] = []; const seen = new Set<string>();
  if (r.queries !== undefined) {
    if (!Array.isArray(r.queries) || r.queries.length > 4) return { ok: false, reason: 'bad_queries' };
    for (const q of r.queries) { const v = validateQuery(q, seen); if (!v.ok) return { ok: false, reason: v.reason }; qs.push(v.query); }
  }
  let changes: Intent = {}, ignored = false;
  if (r.changes !== undefined) {
    const c = validateIntent(normaliseIntentRaw(r.changes, task));
    if (!c.ok) return { ok: false, reason: `bad_changes:${c.reason}` };
    if (r.mode === 'change') changes = c.intent; else ignored = Object.keys(c.intent).length > 0;   // discussion and what-if never change state
  }
  const ui = parseUiAndQuick(r, seen, task);
  if (!ui.ok) return ui;
  return { ok: true, plan: { mode: r.mode, changes, queries: qs, answer: (r.answer as string | undefined)?.trim() ?? '', ui: ui.ui, quick: ui.quick, ignoredChanges: ignored, droppedQuick: ui.dropped } };
}

// ======================= fact guard =======================
/** Figures in the model's wording must be figures the application computed (or the user wrote). Returns the offending tokens. */
export function guardAnswer(text: string, allowed: Allowed): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(/¥\s?(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s?(?:yuan|CNY|RMB)\b/gi)) {
    const cents = Math.round(Number(m[1] ?? m[2]) * 100);
    if (!allowed.cents.has(cents)) bad.push(m[0]);
  }
  for (const m of text.matchAll(new RegExp(MON_RE, 'gi'))) {
    const d = monthDay(m[1], Number(m[2]));
    if (!d || !allowed.dates.has(d)) bad.push(m[0]);
  }
  for (const m of text.matchAll(/\b(\d+)\s*(?:more |fewer |extra |full |whole )?days?\b/gi)) if (!allowed.ints.has(Number(m[1]))) bad.push(m[0]);
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s?km\b/gi)) if (!allowed.km.has(Number(m[1]))) bad.push(m[0]);
  return [...new Set(bad)];
}

// ======================= generic renderers (used when wording is rejected, and as the evidence behind compare cards) =======================
const timingWords: Record<Timing, string> = { on_time: 'arrives in time', late: 'misses the date', unknown: 'timing unknown', no_device: 'gives no working device' };
export const daysWord = (n: number) => (n === 0 ? 'same day' : `${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'} ${n < 0 ? 'earlier' : 'later'}`);
export const centsWord = (n: number) => (n === 0 ? 'same cost' : `${money(Math.abs(n))} ${n < 0 ? 'less' : 'more'}`);

export function describeResult(r: QueryResult): string[] {
  if ('error' in r) return [`${r.tool}: could not be evaluated (${r.error}).`];
  if (r.tool === 'quote_plans') {
    const head = `If ${r.assumptions.join(' and ')}${r.deadlineText ? ` (latest receive date ${r.deadlineText})` : ''}:`;
    return [head, ...r.rows.filter((x) => x.eligible).map((x) => x.plan === 'refund'
      ? `${x.label}: refund arrives ${x.etaAlt}${x.deltaDays ? `, ${daysWord(x.deltaDays)} than now` : ''}; it gives no working device.`
      : `${x.label}: ${x.etaLabel.toLowerCase()} ${x.etaAlt}${x.deltaDays != null ? ` (${daysWord(x.deltaDays)} than now)` : ''}, cost ${x.totalAlt} (${centsWord(x.deltaCents)}); ${x.marginAltDays != null ? marginText(x.marginAltDays) : timingWords[x.timingAlt]}.`),
      ...r.rows.filter((x) => !x.eligible).map((x) => `${x.label}: not available (${x.reason}).`)];
  }
  if (r.tool === 'service_points') return [`Service points near your ${r.nearLabel}:`, ...r.points.map((p) => `${p.name}: ${p.distanceKm} km, open ${p.hours}, ${p.appointment ? 'appointment required' : 'walk-in OK'}${p.supportsPlan === false ? `, does not handle ${PLAN_LABEL[r.plan!].toLowerCase()}` : ''}.`)];
  return r.terms.flatMap((x) => [`${x.label}:`, ...x.lines]);
}
export function fallbackAnswer(t: TaskState, results: QueryResult[]): string {
  const good = results.filter(isGood);
  if (good.length) return good.flatMap(describeResult).join('\n');
  const now = quotesOf(t);
  if (!t.orderId) return 'I cannot compare options yet because no item has been chosen.';
  const lines = now.filter((q) => q.eligible).map((q) => `${PLAN_LABEL[q.plan]}: ${q.etaLabel.toLowerCase()} ${dateText(q.etaDate!)}, cost ${money(q.fees.totalCents)}${q.fees.refundCents != null ? `, refund ${money(q.fees.refundCents)}` : ''}; ${q.marginDays != null && q.plan !== 'refund' ? marginText(q.marginDays) : timingWords[q.timing]}.`);
  return [recommend(now, t.deadline, t.preference).text, ...lines].join('\n');
}
/** One-line summary of what-if results kept in the conversation history, so "use the one we just compared" can be resolved. */
export function memoOf(results: QueryResult[]): string {
  return results.filter(isGood).map((r) => {
    if (r.tool === 'quote_plans') return `[comparison ${r.id}: ${r.assumptions.join(' and ')}${r.applyIntent ? ` | applying it would be ${JSON.stringify(r.applyIntent)}` : ''} | ${r.rows.filter((x) => x.eligible && x.plan !== 'refund').map((x) => `${x.label} ${x.etaAlt} ${x.totalAlt}`).join('; ')}]`;
    if (r.tool === 'service_points') return `[service points ${r.id}: ${r.points.map((p) => `${p.id} ${p.name} ${p.distanceKm} km`).join('; ')}]`;
    return `[plan terms ${r.id}]`;
  }).join(' ');
}

// ======================= orchestration =======================
export interface HistoryItem { role: 'user' | 'agent'; text: string; memo?: string }
export interface TurnInput { message: string; history: HistoryItem[]; task: TaskState }
export type Stage = 'plan' | 'compose' | 'lang' | 'repair';
export type ModelCall = (stage: Stage, system: string, user: string) => Promise<string>;
export interface FinalPlan { mode: Mode; changes: Intent; answer: string; ui: UiItem[]; quick: QuickChoice[] }
export interface TurnOk { kind: 'turn'; plan: FinalPlan; results: QueryResult[]; memo: string; guard: { ok: boolean; violations: string[]; replaced: boolean }; ignoredChanges: boolean; droppedQuick: number; stages: Stage[]; lang?: LangPayload; report?: string | null; notes?: string }
export interface TurnFail { kind: 'failed'; reason: string; stages: Stage[] }
export type TurnOutcome = TurnOk | TurnFail;

const CONTRACT = `You are the planner of an after-sales chat agent in a demo. You decide what THIS turn should do; the application computes every price, date, eligibility and delivery estimate and owns all state. Output ONE JSON object only.
Schema: {"mode":"discuss|what_if|change","changes":{...},"queries":[{"id":"q1","tool":"quote_plans|service_points|policy_terms","args":{...}}],"answer":"...","ui":[{"component":"..."}],"quick":[{"text":"...","changes":{...}}]}
MODE. A message that GIVES information or ANSWERS what the agent is waiting for (PENDING) is a change: it states the product, a problem, a trip, a date, a preference, picks an option ("the first one" = position 1 of PENDING.ordersShownToUser or servicePointsShownToUser), chooses a plan, says where to send the new item or how the old one comes back. Put everything it states in "changes" (even if it also contains a remark or a question you can answer: then also fill "answer" or use queries). discuss = purely a question or request for explanation or advice. what_if = a hypothetical or comparison ("what if", "would it", "how much sooner", "don't change anything yet", "compare"). When the user wants to know something AND has not decided to change it, do NOT change: use discuss/what_if and offer a quick reply that applies it. discuss and what_if never change anything (their "changes" are discarded). You cannot submit: if asked to submit, answer that the user must press "Confirm and submit" on the summary.
ANSWER. For discuss/what_if write the direct answer to the question actually asked: start with the answer, then the reasons, in at most ~90 words. Never reply with "ask away" or "go ahead and ask". Use ONLY figures that appear in FACTS or QUERY RESULTS (copy dates like "Nov 15", amounts like "¥10.00", "3 days", "4.5 km" exactly as written there; do not do your own date or money arithmetic - use the provided deltaDays, marginDays, deltaCents and etaDate fields). If you need a case that FACTS does not contain (another deadline, pickup date, drop-off, a specific service point comparison), declare a query instead of guessing. For mode change leave "answer" empty unless the message also asked a question: the application confirms changes and asks the next question itself. NEVER ask the user for missing information yourself and never list options for them: the application asks the next question (it knows what is missing: see PENDING). Your job is to record what the user said and to answer what the user asked. A request for help that states a problem ("my X is broken, I need it by next week") asks nothing: that is a change with the facts it states and an empty answer.
QUERIES (read-only, max 4, ids q1..q4): quote_plans args {delivery:"home|company|<saved address id>|current", deadline:"YYYY-MM-DD" OR deadlineShiftDays:<integer, e.g. -2 for \"two days earlier\", +3 for \"three days later\"; the application moves the CURRENT latest receive date: use it instead of computing a date yourself>, pickupDate:"YYYY-MM-DD", method:"courier|store", plan:"exchange|repair|refund"} returns all plans NOW versus UNDER THE ASSUMPTION (all fields optional; only what you set is overridden); service_points args {ids:["sp-1"],near:"company|home",plan:"..."}; policy_terms args {plan:"..."}.
UI components to show now (max 3, only what helps THIS question): compare (needs "query":"qN": shows a query result as a comparison, marked "nothing was changed"), plans, servicepoints (optional "ids"), address (optional "mode":"edit"), deadline (date picker), orders, symptoms, dropdate, pickup, terms. Prefer compare for any query. Do not show a component the user did not need.
QUICK replies (max 3) offer a next step; "changes" is applied only if the user clicks it. In "changes", deliveryTarget and locationPref are exactly "home" or "company" (never an address id or a name).
CHANGES uses these keys and values only: orderHint ("headphones"|"speaker"), orderId (from PENDING.ordersShownToUser), symptoms (array of "no_power"|"one_side_silent"|"charging"|"unsure"; one_side_silent = left or right or one side has no sound), deadline and departDate (YYYY-MM-DD, only if the user stated a date), preference ("fastest"|"cheapest"), deliveryTarget, planChoice ("exchange"|"repair"|"refund"), returnMethod ("courier"|"store"; store = the user drops it off), locationPref, servicePointId, pickupDate, pickupSlot (exactly one of "09:00-12:00", "14:00-18:00", "18:00-20:00": the time window the user stated for the courier or the store appointment, e.g. "between 2 and 6 in the afternoon" = "14:00-18:00"; omit when no time was stated), wantsAddress, changeOrder, addressEdit, showTerms (booleans), tripNextWeek (true when the user says only "next week" without a date). deliveryTarget = where the NEW or repaired item is SENT ("home"|"company"); locationPref = where to LOOK for service points. Dates only if the user stated them (today is ${RETAIL_TODAY}). "Use the address we just compared" refers to the comparison memo in HISTORY: apply exactly that and nothing else ("keep everything else" means no other keys). ids (orderId, servicePointId) must be copied from FACTS/HISTORY.`;
const COMPOSE_ADDENDUM = `\nSECOND STEP: QUERY RESULTS are now provided. Return only {"answer":"...","ui":[...],"quick":[...]} (no mode, no changes, no queries). Base every figure on QUERY RESULTS or FACTS.`;
export const turnSystemPrompt = (): string => CONTRACT;
export const composeSystemPrompt = (): string => CONTRACT + COMPOSE_ADDENDUM;

const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
export function userBlock(input: TurnInput, factsText: string, results?: QueryResult[]): string {
  const hist = input.history.slice(-8).map((h) => `${h.role === 'user' ? 'USER' : 'AGENT'}: ${trim(h.text, 400)}${h.memo ? ` ${trim(h.memo, 500)}` : ''}`).join('\n');
  return `${factsText}\n\nHISTORY (oldest first):\n${hist || '(none)'}\n${results ? `\nQUERY RESULTS: ${JSON.stringify(results)}\n` : ''}\nUSER MESSAGE: ${input.message}`;
}
export function parseJson(text: string): unknown { try { return JSON.parse(text.trim().replace(/^```(?:json)?|```$/g, '')); } catch { return undefined; } }

/** Figures a reply may contain: the facts, this turn's tool results, and what the user (or the history) already wrote. */
export function buildAllowed(input: Pick<TurnInput, 'message' | 'history'>, factsText: string, results: QueryResult[]): Allowed {
  const allowed = collectAllowed(results, collectAllowed(JSON.parse(factsText), newAllowed()));
  addNumbersFromText(input.message, allowed);
  for (const m of input.message.matchAll(new RegExp(MON_RE, 'gi'))) { const d = monthDay(m[1], Number(m[2])); if (d) allowed.dates.add(d); }
  for (const h of input.history) addNumbersFromText(`${h.text} ${h.memo ?? ''}`, allowed);
  return allowed;
}

export async function runTurn(input: TurnInput, call: ModelCall): Promise<TurnOutcome> {
  const stages: Stage[] = [];
  const facts = buildFacts(input.task);
  stages.push('plan');
  let raw1: string;
  try { raw1 = await call('plan', turnSystemPrompt(), userBlock(input, facts.text)); } catch (e) { return { kind: 'failed', reason: `model_error: ${(e as Error).message}`, stages }; }
  const j1 = parseJson(raw1);
  if (j1 === undefined) return { kind: 'failed', reason: 'model_output_not_json', stages };
  const p1 = parseTurnPlan(j1, input.task);
  if (!p1.ok) return { kind: 'failed', reason: `invalid_turn_plan:${p1.reason}`, stages };
  const plan = p1.plan;
  const results = runQueries(plan.queries, input.task);
  let answer = plan.answer, ui = plan.ui, quick = plan.quick, droppedQuick = plan.droppedQuick;
  if (plan.queries.length > 0) {
    stages.push('compose');
    let raw2: string;
    try { raw2 = await call('compose', composeSystemPrompt(), userBlock(input, facts.text, results)); } catch (e) { return { kind: 'failed', reason: `model_error(compose): ${(e as Error).message}`, stages }; }
    const j2 = parseJson(raw2);
    if (j2 === undefined || typeof j2 !== 'object' || j2 === null) return { kind: 'failed', reason: 'model_output_not_json(compose)', stages };
    const o = j2 as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!['answer', 'ui', 'quick', 'mode', 'changes', 'queries'].includes(k)) return { kind: 'failed', reason: `invalid_turn_plan(compose):unknown_key:${k}`, stages };
    const ids = new Set(plan.queries.map((q) => q.id));
    const sub = parseUiAndQuick(o, ids, input.task);
    if (!sub.ok) return { kind: 'failed', reason: `invalid_turn_plan(compose):${sub.reason}`, stages };
    if (typeof o.answer !== 'string') return { kind: 'failed', reason: 'invalid_turn_plan(compose):no_answer', stages };
    answer = o.answer.trim(); ui = sub.ui; quick = sub.quick; droppedQuick = plan.droppedQuick + sub.dropped;
  }
  // every evaluated result is shown as evidence even if the model forgot to ask for a card (max 3 components)
  for (const r of results) if (!('error' in r) && r.tool !== 'policy_terms' && !ui.some((u) => u.component === 'compare' && u.query === r.id)) ui = [...ui, { component: 'compare', query: r.id }];
  ui = ui.slice(0, 3);
  // the guard: figures in the wording must come from the application
  const allowed = buildAllowed(input, facts.text, results);
  const violations = answer ? guardAnswer(answer, allowed) : [];
  let replaced = false;
  const needsAnswer = plan.mode !== 'change';
  if (violations.length || (needsAnswer && !answer)) { replaced = true; answer = fallbackAnswer(input.task, results); }
  return { kind: 'turn', plan: { mode: plan.mode, changes: plan.changes, answer, ui, quick }, results, memo: memoOf(results), guard: { ok: violations.length === 0, violations, replaced }, ignoredChanges: plan.ignoredChanges, droppedQuick, stages };
}

// ======================= untrusted input from the browser =======================
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNullStr = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isAddr = (v: unknown): v is Address => { const a = v as Record<string, unknown>; return typeof v === 'object' && v !== null && ['id', 'label', 'recipient', 'phone', 'detail', 'floor'].every((k) => isStr(a[k])) && typeof a.x === 'number' && typeof a.y === 'number' && ['home', 'company', 'custom'].includes(String(a.kind)); };
/** The browser posts its task state so the server can compute facts. Shape-checked; used only by pure functions here. */
export function parseTask(v: unknown): TaskState | null {
  const t = v as Record<string, unknown> | null;
  if (!t || typeof t !== 'object') return null;
  const k = t.pickup as Record<string, unknown> | undefined;
  if (!Array.isArray(t.book) || !t.book.every(isAddr) || !isAddr(t.delivery) || !isAddr(t.pickupAddr) || !k || typeof k !== 'object') return null;
  if (!Array.isArray(t.symptoms) || !t.symptoms.every((s) => SYMPTOMS.some((x) => x.id === s))) return null;
  if (![t.orderId, t.deadline, t.departDate, t.planId, t.preference, t.locationPref, t.orderHint].every(isNullStr)) return null;
  if (t.orderId !== null && !ORDERS.some((o) => o.id === t.orderId)) return null;
  if (!isNullStr(k.method) || !isNullStr(k.date) || !isNullStr(k.slot) || !isNullStr(k.servicePointId)) return null;
  const sub = t.submit as { status?: unknown } | undefined;
  return { ...(t as unknown as TaskState), showAllOrders: t.showAllOrders === true, vagueTrip: t.vagueTrip === true, submit: sub?.status === 'done' ? ({ status: 'done', record: null } as never) : { status: 'idle' } };
}
export function parseHistory(v: unknown): HistoryItem[] {
  if (!Array.isArray(v)) return [];
  return v.slice(-20).flatMap((h) => { const x = h as Record<string, unknown>; return x && (x.role === 'user' || x.role === 'agent') && isStr(x.text) ? [{ role: x.role as 'user' | 'agent', text: x.text.slice(0, 600), memo: isStr(x.memo) ? x.memo.slice(0, 800) : undefined }] : []; });
}
