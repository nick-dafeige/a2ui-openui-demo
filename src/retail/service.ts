/**
 * Simulated after-sales submit service (demo only: no real refund, shipment or booking). Browser-safe and pure: the
 * Vite dev server wraps it with an in-memory store. It RE-VALIDATES the whole request and recomputes the quote before
 * creating anything, and is idempotent per key and per identical payload (requirement sections 4-6, 8).
 */
import { PLAN_LABEL, RETAIL_TODAY, SYMPTOMS, scenarioById, type Address, type PlanId, type SymptomId } from './data.ts';
import { fingerprint, orderById, quotePlan, type Timing } from './rules.ts';
import { initialTask, readiness, type PickupState, type SubmitPayload } from './state.ts';

export interface CaseRecord {
  id: string; status: string; createdOn: string;
  orderId: string; itemName: string; symptoms: string; planId: PlanId; planLabel: string;
  serviceCents: number; shippingCents: number; totalCents: number; refundCents: number | null;
  delivery: Address | null; pickupAddr: Address; pickup: PickupState;
  etaLabel: string; etaDate: string | null; timing: Timing; deadline: string;
  nextSteps: { label: string; date: string }[];
}
export type SubmitResult =
  | { ok: true; record: CaseRecord; duplicate: boolean }
  | { ok: false; created: false; code: 'invalid_request' | 'not_eligible' | 'quote_changed' | 'service_unavailable'; message: string };

export class CaseStore {
  byKey = new Map<string, CaseRecord>();
  byPayload = new Map<string, CaseRecord>();
  byId = new Map<string, CaseRecord>();
  failedOnce = new Set<string>();
  counter = 0;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function parseAddress(v: unknown): Address | null {
  if (!isObj(v) || !['recipient', 'phone', 'detail', 'floor', 'id', 'label'].every((k) => isStr(v[k])) || typeof v.x !== 'number' || typeof v.y !== 'number' || !['home', 'company', 'custom'].includes(String(v.kind))) return null;
  return v as unknown as Address;
}
/** Shape check for untrusted request bodies. Returns null if anything is off. */
export function parsePayload(v: unknown): SubmitPayload | null {
  if (!isObj(v) || !isStr(v.orderId) || !isStr(v.planId) || !isStr(v.deadline) || !isStr(v.quoteFingerprint) || !isStr(v.note)) return null;
  if (!Array.isArray(v.symptoms) || !v.symptoms.every((s) => SYMPTOMS.some((x) => x.id === s))) return null;
  if (!['exchange', 'repair', 'refund'].includes(v.planId)) return null;
  const pickupAddr = parseAddress(v.pickupAddr);
  const delivery = v.delivery === null ? null : parseAddress(v.delivery);
  const k = v.pickup;
  if (!pickupAddr || delivery === undefined || (v.delivery !== null && !delivery) || !isObj(k)) return null;
  const method = k.method === 'courier' || k.method === 'store' ? k.method : null;
  const nul = (x: unknown) => (x === null || isStr(x));
  if (!nul(k.date) || !nul(k.slot) || !nul(k.servicePointId) || !(v.departDate === null || isStr(v.departDate))) return null;
  return { orderId: v.orderId, symptoms: v.symptoms as SymptomId[], note: v.note.slice(0, 500), deadline: v.deadline, departDate: (v.departDate ?? null) as string | null, planId: v.planId as PlanId,
    delivery, pickupAddr, pickup: { method, date: k.date as string | null, slot: k.slot as string | null, servicePointId: k.servicePointId as string | null }, quoteFingerprint: v.quoteFingerprint };
}

function build(store: CaseStore, key: string, p: SubmitPayload, q: NonNullable<ReturnType<typeof quotePlan>>): CaseRecord {
  const order = orderById(p.orderId)!;
  const id = `AS-${RETAIL_TODAY.replaceAll('-', '')}-${String(++store.counter).padStart(4, '0')}`;
  return {
    id, status: 'Received (demo)', createdOn: RETAIL_TODAY, orderId: order.id, itemName: order.name,
    symptoms: p.symptoms.map((s) => SYMPTOMS.find((x) => x.id === s)!.label).join(', '), planId: p.planId, planLabel: PLAN_LABEL[p.planId],
    serviceCents: q.fees.serviceCents, shippingCents: q.fees.shippingCents, totalCents: q.fees.totalCents, refundCents: q.fees.refundCents,
    delivery: p.delivery, pickupAddr: p.pickupAddr, pickup: p.pickup, etaLabel: q.etaLabel, etaDate: q.etaDate, timing: q.timing, deadline: p.deadline,
    nextSteps: q.steps,
  };
}

export function submitCase(store: CaseStore, req: { key: string; scenario: string; payload: unknown; confirmed: unknown }): SubmitResult {
  const bad = (code: 'invalid_request' | 'not_eligible' | 'quote_changed' | 'service_unavailable', message: string): SubmitResult => ({ ok: false, created: false, code, message });
  if (!isStr(req.key) || req.key.length < 4 || req.key.length > 120) return bad('invalid_request', 'Missing a valid submit key. Request not created.');
  if (req.confirmed !== true) return bad('invalid_request', 'No explicit "Confirm and submit" received. Request not created.'); // choosing a plan or editing an address is not authorisation
  const dup = store.byKey.get(req.key);
  if (dup) return { ok: true, record: dup, duplicate: true };
  const p = parsePayload(req.payload);
  if (!p) return bad('invalid_request', 'The submitted content is malformed. Request not created.');
  // identical content inside ONE session is the same request; other sessions never collide with it
  const payloadKey = `${req.key.split(':')[0]}|${fingerprint(p)}`;
  const dupPayload = store.byPayload.get(payloadKey);
  if (dupPayload) { store.byKey.set(req.key, dupPayload); return { ok: true, record: dupPayload, duplicate: true }; }

  // rebuild the task from the payload and run the same readiness + quote rules the UI used
  const sc = scenarioById(req.scenario);
  const t = { ...initialTask(sc), orderId: p.orderId, symptoms: p.symptoms, note: p.note, deadline: p.deadline, departDate: p.departDate, planId: p.planId,
    delivery: p.delivery ?? initialTask(sc).delivery, pickupAddr: p.pickupAddr, pickup: p.pickup };
  const q = quotePlan(p.planId, { orderId: p.orderId, deadline: p.deadline, delivery: t.delivery, pickupDate: p.pickup.date, method: p.pickup.method });
  if (!q) return bad('invalid_request', 'Order not found. Request not created.');
  if (!q.eligible) return bad('not_eligible', `${PLAN_LABEL[p.planId]} is not available: ${q.reason ?? ''}. Request not created.`);
  const problems = readiness(t);
  if (problems.length) return bad('invalid_request', `${problems[0]}. Request not created.`);
  if (fingerprint(q) !== p.quoteFingerprint) return bad('quote_changed', 'The cost or estimated dates have changed. Review the updated plan in the chat and confirm again. Request not created.');

  if (sc.failFirstSubmit && !store.failedOnce.has(req.key)) { store.failedOnce.add(req.key); return bad('service_unavailable', 'The simulated service is temporarily unavailable. Request not created; what you entered is kept and you can safely retry.'); }
  const rec = build(store, req.key, p, q);
  store.byKey.set(req.key, rec); store.byPayload.set(payloadKey, rec); store.byId.set(rec.id, rec);
  return { ok: true, record: rec, duplicate: false };
}

/** Read-only progress for "View progress": derived from the stored record, never invented by the model. */
export function caseProgress(store: CaseStore, id: string): { ok: true; lines: string[] } | { ok: false; message: string } {
  const r = store.byId.get(id);
  if (!r) return { ok: false, message: 'Request not found.' };
  return { ok: true, lines: [`${r.id} · ${r.status}`, ...r.nextSteps.map((s) => `${s.date} ${s.label} (estimated)`), 'Demo environment: no real refund, shipment or booking.'] };
}
