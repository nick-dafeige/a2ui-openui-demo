/**
 * Conversation driver. Each turn: merge what the user said into the task, then ask for exactly ONE missing thing
 * (`nextNeed`), with the smallest component that answers it. Pure: the same state and intent give the same result.
 * Wording is composed from rule-engine output; no number or date comes from the model.
 */
import { PLAN_LABEL, RETAIL_TODAY, SERVICE_POINTS, type PlanId } from './data.ts';
import type { Intent } from './intent.ts';
import { appointmentProblem, checkDeadline, checkDepart, dateText, earliestPickup, isPickupDateValid, latestPickup, money, orderById, quotePlan, servicePointsFor, ZONE_LABEL, zoneOf, type PlanQuote } from './rules.ts';
import { candidateOrders, companyChoice, effectiveLocation, isLocked, nextNeed, quoteInput, quotesOf, readiness, setDelivery, setOrder, setPickup, setPlan, type Card, type CardType, type Need, type QuickReply, type TaskState } from './state.ts';

export interface Reply { text: string; card?: { type: CardType; mode?: Card['mode']; data?: unknown; ids?: string[] }; quick?: QuickReply[]; memo?: string }
export interface FlowResult { task: TaskState; replies: Reply[] }
export interface FlowContext { live?: CardType[] | ((t: TaskState) => CardType[]); answered?: boolean; noAsk?: boolean }   // noAsk: record the change and report it, but do not ask the next question (the model composes that UI)   // answered: a component (not words) just changed the task   // card types that are currently interactive (so a question is not asked twice)

const ACTIONABLE: (keyof Intent)[] = ['orderId', 'symptoms', 'deadline', 'departDate', 'preference', 'deliveryTarget', 'planChoice', 'changeOrder', 'addressEdit', 'returnMethod', 'locationPref', 'servicePointId', 'pickupDate', 'pickupSlot'];
const lc = (p: PlanId) => PLAN_LABEL[p].toLowerCase();
const short = (name: string) => name.replace(/ (Wireless|Bluetooth).*$/, '');

/** What changed for the delivery plans between two quote sets, in words. Late plans are called out explicitly. */
export function describeChange(before: PlanQuote[], after: PlanQuote[], deadline: string | null): string[] {
  const out: string[] = [];
  for (const a of after) {
    if (!a.needsDelivery || !a.eligible) continue;
    const b = before.find((x) => x.plan === a.plan);
    if (!b || !b.eligible) continue;
    const eta = b.etaDate !== a.etaDate ? `estimated delivery changes from ${dateText(b.etaDate!)} to ${dateText(a.etaDate!)}` : `estimated delivery stays ${dateText(a.etaDate!)}`;
    const fee = b.fees.totalCents !== a.fees.totalCents ? `, cost changes from ${money(b.fees.totalCents)} to ${money(a.fees.totalCents)}` : `, cost stays ${money(a.fees.totalCents)}`;
    out.push(`${PLAN_LABEL[a.plan]}: ${eta}${fee}`);
  }
  for (const a of after) if (a.needsDelivery && a.eligible && a.timing === 'late' && deadline) out.push(`⚠ ${PLAN_LABEL[a.plan]} is estimated to arrive ${dateText(a.etaDate!)}, which misses your ${dateText(deadline)} deadline.`);
  return out;
}

const warrantyLine = (id: string | null) => {
  const o = orderById(id);
  return o ? `${short(o.name)} (${RETAIL_TODAY <= o.warrantyEnd ? 'in warranty' : 'out of warranty'})` : '';
};

interface Ask { text: string; card?: Reply['card']; quick?: QuickReply[] }
/** The one question for a need, with the smallest component that answers it. */
function ask(need: Need, t: TaskState): Ask {
  const item = orderById(t.orderId);
  switch (need) {
    case 'order': { const n = candidateOrders(t).length; return { text: `I found ${n} ${t.orderHint === 'headphones' && !t.showAllOrders ? 'headphone ' : ''}order${n === 1 ? '' : 's'}. Which one do you mean?`, card: { type: 'orders' } }; }
    case 'symptoms': return { text: `What is going wrong with the ${item ? short(item.name) : 'item'}?`, card: { type: 'symptoms' } };
    case 'deadline': return { text: t.vagueTrip ? 'You said next week, but I need an exact day to check the shipping. What is the latest date you need working headphones in hand?' : 'What is the latest date you need working headphones in hand?', card: { type: 'deadline' } };
    case 'plan': return { text: 'For that deadline, here is how the three options compare.', card: { type: 'plans' } };
    case 'method': return { text: 'How would you like to send the old item back? A courier can collect it, or you can drop it off yourself at a service point.', quick: [{ text: 'Courier pickup', intent: { returnMethod: 'courier' } }, { text: 'Drop off at a service point', intent: { returnMethod: 'store', wantsAddress: true } }] };
    case 'location': return { text: 'Do you want service points near your company or near your home?', quick: [{ text: 'Near my company', intent: { locationPref: 'company' } }, { text: 'Near my home', intent: { locationPref: 'home' } }] };
    case 'servicepoint': return { text: `Here are the service points that handle ${t.planId ? lc(t.planId) : 'your request'}${effectiveLocation(t) ? `, near your ${effectiveLocation(t)}` : ''}. Pick one.`, card: { type: 'servicepoints' } };
    case 'dropdate': return { text: 'On which day will you drop it off?', card: { type: 'dropdate' } };
    case 'pickup': return { text: 'When should the courier collect it?', card: { type: 'pickup' } };
    case 'confirm': return { text: 'Here is the full summary. Nothing is submitted until you press Confirm and submit.', card: { type: 'confirm' } };
  }
}
/** Shown when the turn recognised nothing: restate the pending question in context instead of a generic error. */
function clarify(need: Need | null, t: TaskState): string {
  switch (need) {
    case 'order': return 'I could not tell which order you mean. Pick one below, or tell me the product name or say "the first one".';
    case 'symptoms': return 'What is wrong with it? For example "the left side has no sound", or pick from the options.';
    case 'deadline': return 'What is the latest date you need it by? Type a date like "Nov 16" or use the date picker.';
    case 'plan': return 'Which plan would you like: exchange, repair or refund? You can also ask about the terms.';
    case 'method': return 'Do you want to drop the old item off yourself, or have a courier collect it?';
    case 'location': return 'Should I look for service points near your company or near your home?';
    case 'servicepoint': return 'Which service point suits you? Pick one on the map or in the list, or tell me its name.';
    case 'dropdate': return 'Which day will you drop it off? Pick a date or type one like "Nov 13".';
    case 'pickup': return 'Which day and time slot suit you for the courier? Pick a date, then a slot.';
    case 'confirm': return 'Everything is ready. Review the summary and press Confirm and submit, or tell me what to change.';
    default: return `Something still needs fixing: ${readiness(t)[0] ?? 'please check the details'}.`;
  }
}

export function applyIntent(t0: TaskState, i: Intent, ctx: FlowContext = {}): FlowResult {
  if (isLocked(t0)) {
    const wants = ACTIONABLE.some((k) => i[k] !== undefined) || i.orderHint !== undefined;
    return { task: t0, replies: [{ text: wants
      ? 'The request has already been submitted, so its receipt cannot be edited directly. To change something, start a change request (in this demo it only records your intent and does not modify the original request).'
      : 'The request has been submitted. You can view its progress or start a change request.', card: wants ? { type: 'change' } : undefined, quick: [{ text: 'View progress', action: 'progress' }] }] };
  }
  let t = { ...t0 };
  const notes: string[] = [];
  const replies: Reply[] = [];
  const before = quotesOf(t);
  const recognised = Object.keys(i).length > 0 || !!ctx.answered;
  let skipNeed = false;

  // ----- who/what -----
  if (i.orderHint && i.orderHint !== t.orderHint) t = { ...t, orderHint: i.orderHint };
  if (i.changeOrder) { t = { ...t, showAllOrders: true, orderId: null, planId: null }; notes.push('OK, here are all your orders.'); }
  if (i.orderId) { const o = orderById(i.orderId)!; t = setOrder(t, i.orderId); notes.push(`Selected ${warrantyLine(o.id)}.`); }
  if (!t.orderId) { const c = candidateOrders(t); if (c.length === 1 && (i.orderHint || t.orderHint)) { t = setOrder(t, c[0].id); notes.push(`You have one matching order: ${warrantyLine(c[0].id)}.`); } }
  if (i.symptoms?.length) { t = { ...t, symptoms: [...new Set([...t.symptoms, ...i.symptoms])] }; notes.push('Got the symptoms.'); }

  // ----- dates -----
  if (i.departDate) { const c = checkDepart(i.departDate); if (c.ok) { t = { ...t, departDate: i.departDate }; notes.push(`Departure noted: ${dateText(i.departDate)}.`); } else notes.push(c.message); }
  if (i.deadline) {
    const c = checkDeadline(i.deadline, t.departDate);
    if (c.ok) { t = { ...t, deadline: i.deadline, vagueTrip: false }; notes.push(`Latest receive date noted: ${dateText(i.deadline)}.`); } else notes.push(c.message);
  }
  if (i.tripNextWeek && !t.deadline) { t = { ...t, vagueTrip: true }; notes.push('Got it, you need working headphones next week.'); }

  // ----- plan, preference, questions -----
  if (i.preference) { t = { ...t, preference: i.preference }; notes.push(i.preference === 'fastest' ? 'Recommendation re-ranked for fastest first.' : 'Recommendation re-ranked for lowest cost first.'); }
  if (i.planChoice) {
    const q = t.orderId ? quotePlan(i.planChoice, quoteInput(t)) : null;
    if (!q) notes.push('Let me pin down the item first, then we can pick a plan.');
    else if (!q.eligible) notes.push(`${PLAN_LABEL[i.planChoice]} is not available: ${q.reason}.`);
    else { t = setPlan(t, i.planChoice); notes.push(`${PLAN_LABEL[i.planChoice]} selected.`); }
  }
  if (i.showTerms) replies.push({ text: 'Here are the terms for each plan.', card: { type: 'terms' } });
  if (i.askQuestion) { notes.push('Open questions need the model to read them. Rules-only mode is on, so I can only show the plan terms here; switch back to Model for explanations and what-if comparisons.'); replies.push({ text: '', card: { type: 'terms' } }); skipNeed = true; }

  // ----- how the old item gets back -----
  if (i.wantsAddress && !i.returnMethod && !t.pickup.method) i = { ...i, returnMethod: 'store' };
  if (i.wantsAddress && !i.returnMethod && t.pickup.method === 'courier') {
    return { task: t, replies: [{ text: `With courier pickup, nobody needs an address: the courier collects from ${t.pickupAddr.label} (${t.pickupAddr.detail}). Do you want to drop it off at a service point instead?`,
      quick: [{ text: 'Drop off at a service point', intent: { returnMethod: 'store', wantsAddress: true } }, { text: 'Keep courier pickup', intent: { returnMethod: 'courier' } }] }] };
  }
  if (i.returnMethod && i.returnMethod !== t.pickup.method) {
    t = setPickup(t, { method: i.returnMethod });
    notes.push(i.returnMethod === 'store' ? 'Noted: you will drop the old item off yourself.' : 'Noted: a courier will collect the old item.');
  }
  if (i.locationPref) { t = { ...t, locationPref: i.locationPref }; notes.push(`Looking for service points near your ${i.locationPref}.`); }
  if (i.servicePointId) {
    const sp = SERVICE_POINTS.find((s) => s.id === i.servicePointId)!;
    if (t.planId && !sp.supports.includes(t.planId)) notes.push(`${sp.name} does not handle ${lc(t.planId)}.`);
    else { const had = t.pickup.slot; t = setPickup(t, { servicePointId: sp.id, method: 'store' }); notes.push(`Drop-off point: ${sp.name}.`); if (had && !t.pickup.slot) notes.push(`The ${had} slot cannot be kept: ${appointmentProblem(sp.id, t.pickup.date, had) ?? 'it is not available there'}.`); }
  }
  if (i.pickupDate) {
    if (isPickupDateValid(i.pickupDate)) { t = setPickup(t, { date: i.pickupDate }); notes.push(`Date noted: ${dateText(i.pickupDate)}.`); }
    else notes.push(`Pickup and drop-off dates must be between ${dateText(earliestPickup())} and ${dateText(latestPickup())}.`);
  }
  if (i.pickupSlot) {
    const probe = setPickup(t, { slot: i.pickupSlot });
    if (probe.pickup.slot === i.pickupSlot) { t = probe; notes.push(`Time slot noted: ${i.pickupSlot}.`); }
    else notes.push(`${i.pickupSlot} cannot be booked: ${t.pickup.method === 'store' ? appointmentProblem(t.pickup.servicePointId, t.pickup.date, i.pickupSlot) ?? 'not available' : 'it is full on that day'}.`);
  }

  // ----- delivery address of the NEW item -----
  if (i.addressEdit) { replies.push({ text: '', card: { type: 'address', mode: 'edit' } }); notes.push('Review or change the delivery address below. The pickup address is saved separately and will not change.'); }
  if (i.deliveryTarget) {
    if (t.planId === 'refund') {
      return { task: t, replies: [{ text: 'A refund does not need a delivery address for a new item, so "ship to my company" would not change it. Do you want to switch to an exchange or repair instead? The pickup address of the old item is saved separately and is not affected.',
        quick: [{ text: 'Choose another plan', action: 'replan' }] }] };
    }
    const target = i.deliveryTarget;
    const c = target === 'company' ? companyChoice(t.book) : null;
    if (target === 'company' && c!.kind === 'none') { notes.push('You have no saved company address. Fill in the recipient details and mark the location on the map.'); replies.push({ text: '', card: { type: 'address', mode: 'fill' } }); }
    else if (target === 'company' && c!.kind === 'many') { notes.push('You have several saved company addresses. Pick one as the delivery address.'); replies.push({ text: '', card: { type: 'address', mode: 'choose' } }); }
    else {
      const addr = target === 'company' ? (c as { kind: 'one'; addr: TaskState['delivery'] }).addr : t.book.find((a) => a.kind === 'home');
      if (!addr) { notes.push('No home address is saved. Please fill it in.'); replies.push({ text: '', card: { type: 'address', mode: 'fill' } }); }
      else {
        t = setDelivery(t, addr);
        notes.push(`Delivery address for the new item changed to "${addr.label}" (${ZONE_LABEL[zoneOf(addr)]}). The pickup address of the old item is unchanged${target === 'company' ? ', and a refund is not affected' : ''}.`);
        replies.push({ text: '', card: { type: 'address', mode: 'single' } });
        if (t.orderId) notes.push(...describeChange(before, quotesOf(t), t.deadline));
      }
    }
  }

  // ----- ask for the one thing still missing -----
  let need = nextNeed(t);
  if (need === 'servicepoint' && t.planId && servicePointsFor(t.planId).length === 0) {
    const pl = t.planId;
    t = setPickup(t, { method: 'courier' });
    notes.push(`Drop-off is not available for ${lc(pl)}, so a courier pickup will be used.`);
    need = nextNeed(t);
  }
  const live = new Set(typeof ctx.live === 'function' ? ctx.live(t) : ctx.live ?? []);   // judged against the UPDATED task
  const first = replies.find((r) => r.card && r.text === '');
  if (first) { first.text = notes.splice(0).join('\n'); }          // the card the user asked for carries the explanation
  if (ctx.noAsk) {
    const keep = replies.filter((r) => r.card?.type === 'address' && r.card.mode !== 'single').map((r) => ({ ...r, text: '' }));
    const text = notes.splice(0).concat(replies.map((r) => r.text).filter(Boolean)).join('\n');
    return { task: t, replies: [...(text ? [{ text }] : []), ...keep] };
  }
  if (!skipNeed) {
    if (need === null || (!recognised && notes.length === 0)) {
      const a = need ? ask(need, t) : null;
      const stillLive = !!a?.card && live.has(a.card.type);
      replies.push({ text: [`I did not quite catch that.`, clarify(need, t)].join(' '), card: a?.card && !stillLive ? a.card : undefined, quick: a?.quick });
    } else {
      const a = ask(need, t);
      const pending = !!a.card && live.has(a.card.type);
      if (pending) replies.push({ text: [...notes.splice(0), 'I still need that: see the question above.'].join(' ') });
      else replies.push({ text: [...notes.splice(0), a.text].join('\n'), card: a.card, quick: a.quick });
    }
  } else if (notes.length) replies.push({ text: notes.splice(0).join('\n') });

  return { task: t, replies: replies.filter((r) => r.text !== '' || r.card || r.quick) };
}
