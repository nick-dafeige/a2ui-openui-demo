import { describe, expect, it } from 'vitest';
import { scenarioById, type ScenarioId } from '../src/retail/data.ts';
import { applyIntent } from '../src/retail/flow.ts';
import { parseIntentLocal, type Intent } from '../src/retail/intent.ts';
import { candidateOrders, cardLive, confirmKey, initialTask, markAnswered, nextNeed, nextRid, payloadOf, readiness, setPickup, setPlan, type CardType, type RMsg, type TaskState } from '../src/retail/state.ts';

/** The same turn logic RetailApp runs, without React, so whole conversations can be asserted. */
function dialog(scn: ScenarioId = 'standard') {
  let t: TaskState = initialTask(scenarioById(scn));
  let msgs: RMsg[] = [];
  const live = (m: RMsg[], base: TaskState): CardType[] => m.flatMap((x, i) => (x.role === 'agent' && x.card && cardLive(m, i, base) ? [x.card.type] : []));
  const step = (base: TaskState, intent: Intent, answered = false) => {
    const marked = markAnswered(msgs, base);
    const r = applyIntent(base, intent, { live: (nt) => live(markAnswered(marked, nt), nt), answered });
    t = r.task;
    msgs = [...markAnswered(marked, t), ...r.replies.map((x): RMsg => ({ id: nextRid('a'), role: 'agent', text: x.text, card: x.card ? { type: x.card.type, mode: x.card.mode, snapshot: t } : undefined, quick: x.quick }))];
    return r;
  };
  return {
    get t() { return t; }, get msgs() { return msgs; },
    say(text: string) { const need = nextNeed(t); return step(t, parseIntentLocal(text, { orders: candidateOrders(t), expect: need === 'order' ? 'order' : need === 'servicepoint' || need === 'location' ? 'servicepoint' : need === 'deadline' ? 'deadline' : need === 'dropdate' || need === 'pickup' ? 'pickupdate' : undefined })); },
    quick: (intent: Intent) => step(t, intent),
    answer: (fn: (x: TaskState) => TaskState) => step(fn(t), {}, true),
    cards: (r: ReturnType<typeof step>) => r.replies.flatMap((x) => (x.card ? [x.card.type] : [])),
    allCards: () => msgs.flatMap((m) => (m.role === 'agent' && m.card ? [m.card.type] : [])),
  };
}
const SAMPLE = 'My headphones are broken and I need them for a business trip next week. Please help.';

describe('the target conversation: one question at a time, components only when needed', () => {
  const d = dialog();
  const r1 = d.say(SAMPLE);
  const vagueAfterTurn1 = d.t.vagueTrip;   // describe bodies run before any `it`, so capture state at the time
  it('turn 1: asks which order (single-choice), nothing else', () => {
    expect(d.cards(r1)).toEqual(['orders']);
    expect(r1.replies[0].text).toContain('I found 2 headphone orders');
    expect(vagueAfterTurn1).toBe(true);
    expect(d.t.vagueTrip).toBe(false);       // cleared once a concrete date arrived
  });
  const r2 = d.say('The first one, the left side has no sound');
  it('turn 2: order AND symptom come from the sentence; only the date is asked', () => {
    expect(d.t.orderId).toBe('RT-20260620-1001');
    expect(d.t.symptoms).toEqual(['one_side_silent']);
    expect(r2.replies[0].text).toContain('Selected Aurora Pro (in warranty)');
    expect(d.cards(r2)).toEqual(['deadline']);
    expect(r2.replies[0].text).toContain('exact day'); // "next week" is not accepted as a date
    expect(d.msgs.find((m) => m.role === 'agent' && m.card?.type === 'orders')).toMatchObject({ answered: true }); // the order card collapsed
  });
  const r3 = d.quick({ deadline: '2026-11-16' });
  it('turn 3: with the date, the plans appear compactly', () => {
    expect(d.cards(r3)).toEqual(['plans']);
  });
  const r4 = d.say('Exchange, ship it to my company');
  it('turn 4: plan + company address in one sentence; address summary with recalculated times, then the next question', () => {
    expect(d.t.planId).toBe('exchange');
    expect(d.t.delivery.id).toBe('company-1');
    expect(d.t.pickupAddr.id).toBe('home-1');
    expect(d.cards(r4)).toEqual(['address']);
    expect(r4.replies[0].text).toContain('estimated delivery changes from Nov 15 to Nov 16');
    expect(r4.replies[0].text).toContain('cost changes from ¥0.00 to ¥10.00');
    expect(r4.replies[1].quick?.map((q) => q.text)).toEqual(['Courier pickup', 'Drop off at a service point']); // method is a question, not a form
  });
  const r5 = d.say('I would like to drop-off, give me the address');
  it('turn 5: the drop-off wish is understood; location unknown, so ONE question', () => {
    expect(d.t.pickup.method).toBe('store');
    expect(d.cards(r5)).toEqual([]);
    expect(r5.replies.at(-1)!.text).toContain('near your company or near your home');
    expect(r5.replies.at(-1)!.text).not.toMatch(/did not quite catch/);
  });
  const r6 = d.say('Near my company');
  it('turn 6: service points with a map/list', () => {
    expect(d.t.locationPref).toBe('company');
    expect(d.cards(r6)).toEqual(['servicepoints']);
  });
  const r7 = d.quick({ servicePointId: 'sp-1' });
  it('turn 7: chosen point -> only the drop-off date is missing', () => {
    expect(d.t.pickup.servicePointId).toBe('sp-1');
    expect(d.cards(r7)).toEqual(['dropdate']);
  });
  const r8 = d.quick({ pickupDate: '2026-11-13' });
  it('turn 8: now (and only now) the full summary with the confirm button', () => {
    expect(d.cards(r8)).toEqual(['confirm']);
    expect(readiness(d.t)).toEqual([]);
    const p = payloadOf(d.t)!;
    expect(p.pickup).toMatchObject({ method: 'store', servicePointId: 'sp-1', date: '2026-11-13' });
    expect(p.delivery?.id).toBe('company-1');
    expect(confirmKey(d.t)).not.toBe('not-ready');
  });
  it('nothing was asked twice and no big form ever appeared', () => {
    const all = d.allCards();
    expect(all.filter((c) => c === 'orders').length).toBe(1);
    expect(all).not.toContain('symptoms');
    expect(all.filter((c) => c === 'deadline').length).toBe(1);
    expect(all.filter((c) => c === 'plans').length).toBe(1);
  });
});

describe('same journey through components only', () => {
  it('order, symptoms, date, plan, courier pickup date and slot -> summary', () => {
    const d = dialog();
    d.say('my headphones broke');
    d.quick({ orderId: 'RT-20260620-1001' });
    d.answer((t) => ({ ...t, symptoms: ['no_power', 'charging'] }));
    expect(d.t.symptoms).toEqual(['no_power', 'charging']);
    d.quick({ deadline: '2026-11-16' });
    d.quick({ planChoice: 'exchange' });
    expect(nextNeed(d.t)).toBe('method');
    const r = d.quick({ returnMethod: 'courier' });
    expect(d.cards(r)).toEqual(['pickup']);
    d.answer((t) => setPickup(t, { date: '2026-11-12' }));  // date picked, slots now shown
    const done = d.answer((t) => setPickup(t, { slot: '09:00-12:00' }));
    expect(d.cards(done)).toEqual(['confirm']);
  });
});

describe('what the agent does when it does not understand', () => {
  it('restates the pending question in context and never says "use the cards"', () => {
    const d = dialog();
    d.say(SAMPLE); d.say('first one, left side silent'); d.quick({ deadline: '2026-11-16' }); d.say('exchange');
    const r = d.say('hmm what now');
    const text = r.replies.map((x) => x.text).join(' ');
    expect(text).toContain('I did not quite catch that.');
    expect(text).toContain('drop the old item off yourself, or have a courier collect it');
    expect(text).not.toMatch(/cards? below|another way|no updates/i);
    expect(r.replies.at(-1)!.quick?.length).toBe(2);
  });
  it('does not duplicate a question card that is still open', () => {
    const d = dialog();
    d.say(SAMPLE);
    const r = d.say('banana');
    expect(d.cards(r)).toEqual([]);                       // the orders card above is still live
    expect(r.replies[0].text).toContain('Pick one below');
    expect(d.allCards().filter((c) => c === 'orders').length).toBe(1);
  });
  it('courier chosen + "give me the address": asks whether they meant drop-off instead of guessing', () => {
    const d = dialog();
    d.say(SAMPLE); d.say('first one, no sound on the left'); d.quick({ deadline: '2026-11-16' }); d.quick({ planChoice: 'exchange' }); d.quick({ returnMethod: 'courier' });
    const r = d.say('give me the address');
    expect(d.t.pickup.method).toBe('courier');
    expect(r.replies[0].text).toContain('Do you want to drop it off at a service point instead?');
  });
});

describe('information given early is kept, not asked again', () => {
  it('a drop-off wish stated before the plan is stored and used later', () => {
    const d = dialog();
    d.say('My headphones are dead, I will drop them off myself');
    expect(d.t.pickup.method).toBe('store');
    d.say('the first one'); d.quick({ deadline: '2026-11-16' });
    const r = d.quick({ planChoice: 'exchange' });
    expect(d.cards(r)).not.toContain('plans');
    expect(r.replies.at(-1)!.text).toContain('near your company or near your home'); // method already known: straight to location
  });
  it('no company address saved: service points are searched near home without asking', () => {
    const d = dialog('no_company');
    d.say(SAMPLE); d.say('first one, left side silent'); d.quick({ deadline: '2026-11-16' }); d.quick({ planChoice: 'exchange' });
    const r = d.say('I want to drop it off myself, where can I go?');
    expect(d.cards(r)).toEqual(['servicepoints']);
  });
  it('a refund has no delivery address: "ship to company" is clarified, state untouched', () => {
    const d = dialog();
    d.say(SAMPLE); d.say('first one, no sound on the left'); d.quick({ deadline: '2026-11-16' }); d.quick({ planChoice: 'refund' });
    const before = d.t.delivery.id;
    const r = d.say('ship it to my company');
    expect(d.t.delivery.id).toBe(before);
    expect(r.replies[0].text).toContain('A refund does not need a delivery address');
  });
});

describe('changes after the fact', () => {
  const ready = () => {
    const d = dialog();
    d.say(SAMPLE); d.say('first one, left side silent'); d.quick({ deadline: '2026-11-16' }); d.quick({ planChoice: 'exchange' }); d.quick({ returnMethod: 'courier' });
    d.answer((t) => setPickup(t, { date: '2026-11-12' })); d.answer((t) => setPickup(t, { slot: '09:00-12:00' }));
    return d;
  };
  it('changing the delivery address recalculates, outdates the old plan list and the old summary', () => {
    const d = ready();
    const confirmIdx = d.msgs.findIndex((m) => m.role === 'agent' && m.card?.type === 'confirm');
    expect(cardLive(d.msgs, confirmIdx, d.t)).toBe(true);
    const r = d.say('actually ship it to my company');
    expect(r.replies[0].text).toContain('cost changes from ¥0.00 to ¥10.00');
    expect(cardLive(d.msgs, confirmIdx, d.t)).toBe(false);
    expect(d.cards(r)).toContain('address');
    expect(d.cards(r)).toContain('confirm');               // a new summary replaces the outdated one
  });
  it('changing the time clears only date and slot; the rest is kept', () => {
    const d = ready();
    const r = d.answer((t) => setPickup(t, { date: null, slot: null }));
    expect(d.t.planId).toBe('exchange'); expect(d.t.pickup.method).toBe('courier');
    expect(d.cards(r)).toEqual(['pickup']);
  });
  it('choosing another plan keeps the answers about item, date and return method', () => {
    const d = ready();
    const r = d.answer((t) => setPlan(t, null));
    expect(d.t.orderId).toBe('RT-20260620-1001'); expect(d.t.pickup.method).toBe('courier');
    expect(d.cards(r)).toEqual(['plans']);
  });
  it('a plan that has no drop-off points falls back to courier with an explanation (nothing breaks)', () => {
    const d = dialog();
    d.say(SAMPLE); d.say('first one, left side silent'); d.quick({ deadline: '2026-11-16' }); d.quick({ planChoice: 'refund' });
    const r = d.quick({ returnMethod: 'store', locationPref: 'home' });
    expect(d.cards(r)).toEqual(['servicepoints']);          // refund is handled by sp-1 and sp-3
    expect(d.t.pickup.method).toBe('store');
  });
});
