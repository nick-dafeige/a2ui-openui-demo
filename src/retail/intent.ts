/**
 * Natural language -> Intent. The model (or the labelled rules fallback) only EXTRACTS what the user said; every key is
 * validated against a whitelist here. It never supplies fees, eligibility, dates of delivery, orders or case numbers.
 */
import { ORDERS, PICKUP_SLOTS, PLAN_IDS, RETAIL_TODAY, SERVICE_POINTS, type Order, type PlanId, type SymptomId } from './data.ts';
import { isIsoDate, normaliseSlot } from './rules.ts';

export interface Intent {
  orderHint?: 'headphones' | 'speaker';
  orderId?: string;           // one of the known orders (resolved from "the first one", "the Pro", ...)
  symptoms?: SymptomId[];
  deadline?: string;          // YYYY-MM-DD, only when the user gave a concrete date for "latest receive"
  departDate?: string;        // YYYY-MM-DD, only when the user gave a concrete departure date
  tripNextWeek?: boolean;     // vague "next week" - the app must ask for concrete dates
  preference?: 'fastest' | 'cheapest';
  deliveryTarget?: 'company' | 'home';   // where the NEW / repaired item is delivered
  planChoice?: PlanId;
  returnMethod?: 'courier' | 'store';    // how the OLD item gets back: courier pickup or the user drops it off
  locationPref?: 'company' | 'home';     // where to look for service points ("near my company")
  servicePointId?: string;    // one of the known service points
  pickupDate?: string;        // YYYY-MM-DD pickup / drop-off date, only if stated
  pickupSlot?: string;        // one bookable slot ("09:00-12:00" | "14:00-18:00" | "18:00-20:00"): courier slot or store appointment, only if stated
  wantsAddress?: boolean;     // "give me the address" / "where can I drop it off"
  changeOrder?: boolean;
  addressEdit?: boolean;
  showTerms?: boolean;
  askQuestion?: boolean;      // "let me ask something first"
}
const SYMPTOM_IDS: SymptomId[] = ['no_power', 'one_side_silent', 'charging', 'unsure'];
const KEYS = ['orderHint', 'orderId', 'symptoms', 'deadline', 'departDate', 'tripNextWeek', 'preference', 'deliveryTarget', 'planChoice', 'returnMethod', 'locationPref', 'servicePointId', 'pickupDate', 'pickupSlot', 'wantsAddress', 'changeOrder', 'addressEdit', 'showTerms', 'askQuestion'];
const BOOLS = ['tripNextWeek', 'wantsAddress', 'changeOrder', 'addressEdit', 'showTerms', 'askQuestion'] as const;

export type IntentCheck = { ok: true; intent: Intent } | { ok: false; reason: string };
/** Strict validation for untrusted input (model JSON). Unknown keys or bad values reject the whole intent. */
export function validateIntent(raw: unknown): IntentCheck {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'not_object' };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!KEYS.includes(k)) return { ok: false, reason: `unknown_key:${k}` };
  const out: Intent = {};
  const oneOf = (k: string, allowed: readonly unknown[]) => (r[k] === undefined ? undefined : allowed.includes(r[k]) ? (r[k] as never) : null);
  if (r.orderHint !== undefined) { if (r.orderHint !== 'headphones' && r.orderHint !== 'speaker') return { ok: false, reason: 'bad_orderHint' }; out.orderHint = r.orderHint; }
  if (r.orderId !== undefined) { if (!ORDERS.some((o) => o.id === r.orderId)) return { ok: false, reason: 'bad_orderId' }; out.orderId = r.orderId as string; }
  if (r.symptoms !== undefined) {
    if (!Array.isArray(r.symptoms) || !r.symptoms.every((s) => SYMPTOM_IDS.includes(s as SymptomId))) return { ok: false, reason: 'bad_symptoms' };
    out.symptoms = [...new Set(r.symptoms as SymptomId[])];
  }
  for (const k of ['deadline', 'departDate', 'pickupDate'] as const) if (r[k] !== undefined) { if (!isIsoDate(r[k])) return { ok: false, reason: `bad_${k}` }; out[k] = r[k] as string; }
  for (const k of BOOLS) if (r[k] !== undefined) { if (typeof r[k] !== 'boolean') return { ok: false, reason: `bad_${k}` }; if (r[k]) out[k] = true; }
  for (const [k, allowed] of [['preference', ['fastest', 'cheapest']], ['deliveryTarget', ['company', 'home']], ['returnMethod', ['courier', 'store']], ['locationPref', ['company', 'home']], ['planChoice', PLAN_IDS], ['servicePointId', SERVICE_POINTS.map((s) => s.id)]] as const) {
    const v = oneOf(k, allowed);
    if (v === null) return { ok: false, reason: `bad_${k}` };
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  if (r.pickupSlot !== undefined) { if (typeof r.pickupSlot !== 'string' || !(PICKUP_SLOTS as readonly string[]).includes(r.pickupSlot)) return { ok: false, reason: 'bad_pickupSlot' }; out.pickupSlot = r.pickupSlot; }
  return { ok: true, intent: out };
}
export const isEmptyIntent = (i: Intent): boolean => Object.keys(i).length === 0;

// ---------------- rules fallback ----------------
const PLAN_WORD: [RegExp, PlanId][] = [[/exchange|replace|换货/i, 'exchange'], [/repair|fix|维修|修理/i, 'repair'], [/refund|money back|退款|退货/i, 'refund']];
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const MONTH = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ORDINAL: [RegExp, number][] = [
  [/\b(the )?(first|1st)( one| order| item| option| model| pair| headphones| result| choice)?\b(?! first)|第一(款|个|件|笔)|\b(option|number|#)\s*(1|one)\b/i, 0],
  [/\b(the )?(second|2nd)( one| order| item| option| model| pair| headphones| result| choice)?\b|第二(款|个|件|笔)|\b(option|number|#)\s*(2|two)\b/i, 1],
  [/\b(the )?(third|3rd)( one| order| item| option| model| result| choice)?\b|第三(款|个|件|笔)|\b(option|number|#)\s*(3|three)\b/i, 2],
];

export interface ParseContext {
  orders?: Order[];                       // candidates in the order they were shown
  expect?: 'order' | 'servicepoint' | 'deadline' | 'pickupdate';   // what the agent is currently waiting for (lets "the first one" mean the right thing)
}

/** Deterministic fallback parser (no model), English first, with a few Chinese phrases. The UI labels its results. */
export function parseIntentLocal(text: string, ctx: ParseContext = {}): Intent {
  const t = text.trim();
  const out: Intent = {};
  if (/headphone|earbud|earphone|airpod|耳机/i.test(t)) out.orderHint = 'headphones'; else if (/speaker|音箱/i.test(t)) out.orderHint = 'speaker';

  // which order: ordinal against what was shown, or a distinguishing product word
  const orders = ctx.orders ?? [];
  if (orders.length) {
    const byName = orders.filter((o) => new RegExp(`\\b${(o.sku.split('-')[1] ?? o.sku)}\\b`, 'i').test(t));
    if (byName.length === 1) out.orderId = byName[0].id;
    else if (ctx.expect === 'order' && !/(fastest|quickest|cheapest|lowest cost|cost|speed) first|first (of all|thing)/i.test(t)) for (const [re, idx] of ORDINAL) if (re.test(t) && orders[idx]) { out.orderId = orders[idx].id; break; }
    if (!out.orderId && ctx.expect === 'order' && /\b(the )?last( one)?\b/i.test(t)) out.orderId = orders[orders.length - 1].id;
  }
  if (ctx.expect === 'servicepoint') {
    const byWord: [RegExp, string][] = [[/central|center|centre|\bfirst\b|第一/i, 'sp-1'], [/new district|store|experience|\bsecond\b|第二/i, 'sp-2'], [/west|pick-?up point|\bthird\b|第三/i, 'sp-3']];
    const hit = byWord.filter(([re]) => re.test(t));
    if (hit.length === 1) out.servicePointId = hit[0][1];
  }

  const sym: SymptomId[] = [];
  if (/(won'?t|will not|doesn'?t|does not|can'?t|cannot|not)\s+(power|turn|switch)\s*(on)?|no power|(is |it'?s )?dead\b|无法开机|开不了机/i.test(t)) sym.push('no_power');
  if (/(one side|left|right)\b[^,.]{0,20}(silent|no sound|not working|dead|mute)|no sound (on|in|from) (the )?(left|right)|单侧无声|(左耳|右耳|左边|右边|一边)[^，。,]{0,4}(无声|没声)/i.test(t)) sym.push('one_side_silent');
  if (/charging (problem|issue|error|fault)|(won'?t|doesn'?t|does not|will not|not)\s+charg|charg\w* (is )?(broken|faulty)|充电异常/i.test(t)) sym.push('charging');
  if (/not sure what|don'?t know what'?s wrong|unsure|不确定故障/i.test(t)) sym.push('unsure');
  if (sym.length) out.symptoms = sym;

  // concrete dates: 2026-11-16 / Nov 16 / November 16 / 16 Nov / 11月16日 (year defaults to the reference year). Role comes from nearby words.
  const found: { idx: number; len: number; date: string }[] = [];
  const year = Number(RETAIL_TODAY.slice(0, 4));
  const monthRe = '\\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';   // whole month names only ("margin 0" is not a date)
  const re = new RegExp(`(\\d{4})-(\\d{1,2})-(\\d{1,2})|${monthRe}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${monthRe}|(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*[日号]?`, 'gi');
  for (const m of t.matchAll(re)) {
    const date = m[1] ? iso(+m[1], +m[2], +m[3]) : m[4] ? iso(year, MONTH.indexOf(m[4].toLowerCase().slice(0, 3)) + 1, +m[5]) : m[6] ? iso(year, MONTH.indexOf(m[7].toLowerCase().slice(0, 3)) + 1, +m[6]) : iso(year, +m[8], +m[9]);
    if (isIsoDate(date)) found.push({ idx: m.index!, len: m[0].length, date });
  }
  for (const f of found) {
    const before = t.slice(Math.max(0, f.idx - 14), f.idx), after = t.slice(f.idx + f.len, f.idx + f.len + 14);
    const near = before + ' ' + after;
    const recvWords = /\b(by|before|latest|receive|received|arrive|arrives|delivered|need (them|it))\b|最晚|之前|收到|到货/i;
    const wider = t.slice(Math.max(0, f.idx - 28), f.idx);
    if (/\b(pick ?up|pick-up|drop[ -]?off|drop (it|them|the \w+) off|collect|bring (it|them)|take (it|them)|come (by|on))\b/i.test(wider)) out.pickupDate = f.date;
    else if (/\b(depart|departing|leave|leaving|fly|flying|trip starts)\b|出发|动身/i.test(near) && !/\b(receive|received|arrive|delivered)\b|收到/i.test(before + after.slice(0, 10))) out.departDate = f.date;
    else if (recvWords.test(near)) out.deadline = f.date;
    else if (ctx.expect === 'deadline') out.deadline = f.date;             // a bare date answers the question that was just asked
    else if (ctx.expect === 'pickupdate') out.pickupDate = f.date;
  }
  const slotRange = normaliseSlot(t);
  if (slotRange) out.pickupSlot = slotRange;
  else if (/\b(morning|forenoon)\b|上午/i.test(t) && /\b(pick ?up|drop|appointment|slot|come|bring|visit)|预约|上门|到店/i.test(t)) out.pickupSlot = '09:00-12:00';
  else if (/\bafternoon\b|下午/i.test(t) && /\b(pick ?up|drop|appointment|slot|come|bring|visit)|预约|上门|到店/i.test(t)) out.pickupSlot = '14:00-18:00';
  else if (/\bevening\b|晚上/i.test(t) && /\b(pick ?up|drop|appointment|slot|come|bring|visit)|预约|上门|到店/i.test(t)) out.pickupSlot = '18:00-20:00';
  if (/next week|下周/i.test(t) && /trip|travel|business|need|use|出差|出发|要用/i.test(t) && !out.departDate && !out.deadline) out.tripNextWeek = true;

  if (/fastest|asap|as soon as possible|quickest|尽快|最快/i.test(t)) out.preference = 'fastest';
  else if (/cheapest|lowest cost|low cost|save money|least expensive|低费用|便宜/i.test(t)) out.preference = 'cheapest';

  // how the old item gets back
  if (/drop[\s-]?off|drop (it|them|the \w+) (off|at|by)|take (it|them) (in|to)|bring (it|them) (in|to)|walk[- ]?in|in person|self[- ]?(ship|send|post|deliver)|(send|ship|post|mail) (it|them) (back )?(myself|on my own)|on my own|myself\b.*\b(send|ship|drop|post)|自己(拿去|去|带去)?(寄|送)|到店/i.test(t)) out.returnMethod = 'store';
  else if (/courier|pick ?-?up\b|picked up|come (and )?(get|collect)|collect (it|them)|from my (door|home|house)|door ?step|上门/i.test(t) && !/pick(-| )?up (date|time|slot)/i.test(t)) out.returnMethod = 'courier';
  if (/(give|show|tell|send) me (the |an? )?(address|location|list)|where (can|do|should|is|are)|nearest|closest|service points?|which (store|branch|place|one)|给我地址|在哪/i.test(t) && !/change|edit|修改/i.test(t)) out.wantsAddress = true;
  if (/(near|around|close to|next to|by)\s+(my\s+)?(the\s+)?(company|office|work)\b|公司附近/i.test(t)) out.locationPref = 'company';
  else if (/(near|around|close to|next to|by)\s+(my\s+)?(the\s+)?(home|house)\b|家附近/i.test(t)) out.locationPref = 'home';

  if (!out.locationPref) {
    if (/(ship|send|deliver|mail|post)\w*\b[^,.]{0,20}\b(company|office|work)\b|\b(company|office|work) address|use (my )?company|寄到公司|公司地址/i.test(t)) out.deliveryTarget = 'company';
    else if (/(ship|send|deliver|mail|post)\w*\b[^,.]{0,20}\b(home|house)\b|\bhome address|use (my )?home|寄到家|家庭地址/i.test(t)) out.deliveryTarget = 'home';
  }
  if (/change (the )?(delivery )?address|edit (the )?address|修改地址/i.test(t)) out.addressEdit = true;
  if (/another order|different order|other order|wrong order|all (my )?orders|换一个订单/i.test(t)) out.changeOrder = true;
  if (/\bterms\b|conditions|方案条件/i.test(t)) out.showTerms = true;
  if (/(i have a |a )?question|ask (you )?something|before (i|we) (choose|decide)|想先问问/i.test(t)) out.askQuestion = true;
  // plan choice: judged per sentence, so "Repair is fine. Where can I drop it off?" still chooses repair, while "Can I get a refund?" does not
  for (const sentence of t.split(/(?<=[.!?。！？])\s*/).filter(Boolean)) {
    const asksQuestion = /\?\s*$/.test(sentence) || /^(can|could|what|how|why|is|are|do|does|will|would)\b/i.test(sentence.trim());
    for (const [re2, id] of PLAN_WORD) {
      const w = re2.source;
      if (new RegExp(`(choose|pick|select|take|want|prefer|go with|go for|opt for|let'?s do|let'?s go with|i'?ll (take|do|go with)|i'?d like|would like|选|办|要)\\s*(to do |to go with )?(the |an? )?(${w})`, 'i').test(sentence) && !asksQuestion) out.planChoice = id;
      else if (!asksQuestion && new RegExp(`^\\s*(${w})\\b`, 'i').test(sentence)) out.planChoice = id;   // "Exchange please", "Repair is fine", "Refund, thanks"
    }
  }
  return out;
}

export function retailSystemPrompt(): string {
  return [
    'You extract what a customer said in an after-sales chat into ONE JSON object. Output JSON only.',
    `Allowed keys: ${KEYS.join(', ')}. No other keys. Never output prices, fees, case numbers, delivery estimates or eligibility. Omit any key you are not sure about.`,
    'The message is preceded by a "Context" block listing what was shown to the user and what the agent is waiting for. Use it to resolve references such as "the first one" or "the Pro".',
    'orderHint: "headphones" | "speaker" when the user names the product kind. orderId: ONLY an order id copied from the Context list, when the user picks one (by position, name or description).',
    'symptoms: array of no_power (cannot power on) | one_side_silent (one side / left / right has no sound) | charging (charging problem) | unsure (user is not sure).',
    `Today is ${RETAIL_TODAY}. deadline = the concrete date by which the user needs a working device in hand (YYYY-MM-DD). departDate = concrete departure/trip date. pickupDate = a concrete date for sending the old item back (courier pickup or personal drop-off). pickupSlot = the time window the user stated for that pickup or store appointment, exactly one of 09:00-12:00 | 14:00-18:00 | 18:00-20:00 ("2pm to 6pm" = 14:00-18:00); omit it when no time was stated. Only output a date the user actually stated. If the user says only "next week" without a date, set tripNextWeek=true and do NOT guess dates.`,
    'preference: "fastest" | "cheapest". planChoice: exchange | repair | refund, only if the user explicitly chooses one.',
    'deliveryTarget: "company" | "home" = where the NEW or repaired item should be SENT TO (e.g. "ship it to my company").',
    'returnMethod: how the OLD item gets back to us: "store" if the user will take/drop it off themselves at a service point or store; "courier" if they want someone to collect it. locationPref: "company" | "home" when they want service points near one of those. servicePointId: ONLY an id from the Context list when they pick a service point. wantsAddress=true when they ask for an address/location of where to drop it off.',
    'changeOrder / addressEdit / showTerms / askQuestion: true only when the user asks for it.',
  ].join('\n');
}

export type InterpretOutcome = { kind: 'intent'; intent: Intent; source: 'live' } | { kind: 'failed'; reason: string };
export type Complete = (system: string, user: string) => Promise<string>;
export async function interpretMessage(message: string, complete: Complete, context = ''): Promise<InterpretOutcome> {
  let text: string;
  try { text = await complete(retailSystemPrompt(), `Context:\n${context || '(none)'}\n\nUser message: ${message}`); } catch (e) { return { kind: 'failed', reason: `model_error: ${(e as Error).message}` }; }
  let raw: unknown;
  try { raw = JSON.parse(text.trim().replace(/^```(?:json)?|```$/g, '')); } catch { return { kind: 'failed', reason: 'model_output_not_json' }; }
  const v = validateIntent(raw);
  return v.ok ? { kind: 'intent', intent: v.intent, source: 'live' } : { kind: 'failed', reason: `invalid_model_intent:${v.reason}` };
}
