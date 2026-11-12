import { describe, expect, it } from 'vitest';
import { scenarioById } from '../src/retail/data.ts';
import { applyIntent, describeChange } from '../src/retail/flow.ts';
import { cardLive, confirmKey, initialTask, nextNeed, payloadOf, plansKey, quotesOf, readiness, setDelivery, setOrder, setPickup, setPlan, type RMsg, type TaskState } from '../src/retail/state.ts';

const O1 = 'RT-20260620-1001', O2 = 'RT-20250418-0733';
const ready = (sc: Parameters<typeof scenarioById>[0] = 'standard', o: Partial<TaskState> = {}): TaskState =>
  ({ ...initialTask(scenarioById(sc)), orderId: O1, symptoms: ['one_side_silent'], deadline: '2026-11-16', departDate: '2026-11-17', ...o });
const types = (r: ReturnType<typeof applyIntent>) => r.replies.map((x) => x.card?.type);

describe('first message and dates', () => {
  const r = applyIntent(initialTask(scenarioById('standard')), { orderHint: 'headphones', tripNextWeek: true });
  it('asks which order first (not for every field), and does not guess dates from "next week"', () => {
    expect(r.task.deadline).toBeNull();
    expect(r.task.vagueTrip).toBe(true);
    expect(types(r)).toEqual(['orders']);
    expect(nextNeed(r.task)).toBe('order');
  });
  it('the next missing thing is derived from what is known', () => {
    const t = initialTask(scenarioById('standard'));
    expect(nextNeed({ ...t, orderId: O1 })).toBe('symptoms');
    expect(nextNeed({ ...t, orderId: O1, symptoms: ['no_power'] })).toBe('deadline');
    expect(nextNeed(ready('standard', { deadline: '2026-11-18' }))).toBe('deadline'); // after the departure date: ask again
    expect(nextNeed(ready())).toBe('plan');
    expect(nextNeed(setPlan(ready(), 'exchange'))).toBe('method');
  });
  it('an invalid date is explained and not stored', () => {
    const x = applyIntent(ready('standard', { deadline: null }), { deadline: '2026-11-09' });
    expect(x.task.deadline).toBeNull();
    expect(x.replies[0].text).toContain('must be after today');
  });
  it('a deadline after the departure date is rejected', () => {
    const x = applyIntent(ready('standard', { deadline: null }), { deadline: '2026-11-18' });
    expect(x.task.deadline).toBeNull();
    expect(x.replies[0].text).toContain('cannot be after the departure date');
  });
});

describe('step 3: "ship it to my company"', () => {
  it('one saved company address: selected directly, pickup address untouched, cost and ETA recalculated', () => {
    const r = applyIntent(ready(), { deliveryTarget: 'company' });
    expect(r.task.delivery.id).toBe('company-1');
    expect(r.task.pickupAddr.id).toBe('home-1');            // old item pickup is NOT changed
    expect(types(r)).toContain('address');
    expect(r.replies[0].card?.mode).toBe('single');
    expect(r.replies[0].text).toContain('estimated delivery changes from Nov 15 to Nov 16');
    expect(r.replies[0].text).toContain('cost changes from ¥0.00 to ¥10.00');
    expect(r.replies[0].text).not.toContain('⚠ Exchange');        // exchange 11-16 still meets the 11-16 deadline
    expect(r.replies[0].text).toContain('⚠ Repair is estimated to arrive Nov 20');   // repair was already late and is called out
  });
  it('no company address: asks to fill it in and changes nothing', () => {
    const t = ready('no_company');
    const r = applyIntent(t, { deliveryTarget: 'company' });
    expect(r.task.delivery).toEqual(t.delivery);
    expect(r.replies[0].card).toEqual({ type: 'address', mode: 'fill' });
  });
  it('several company addresses: asks to choose and changes nothing', () => {
    const t = ready('multi_company');
    const r = applyIntent(t, { deliveryTarget: 'company' });
    expect(r.task.delivery).toEqual(t.delivery);
    expect(r.replies[0].card).toEqual({ type: 'address', mode: 'choose' });
  });
  it('a remote company address that makes the exchange miss the date is called out, with alternatives still shown', () => {
    const t = ready('multi_company'); const c2 = t.book[2];
    const text = describeChange(quotesOf(t), quotesOf(setDelivery(t, c2)), t.deadline).join('\n');
    expect(text).toContain('Exchange: estimated delivery changes from Nov 15 to Nov 19, cost changes from ¥0.00 to ¥25.00');
    expect(text).toContain('⚠ Exchange is estimated to arrive Nov 19, which misses your Nov 16 deadline');
  });
  it('"change address" explains that the pickup address is saved separately', () => {
    expect(applyIntent(ready(), { addressEdit: true }).replies[0].text).toContain('saved separately');
  });
  it('with the refund plan selected it asks what "ship to my company" means instead of changing anything', () => {
    const t = setPlan(ready(), 'refund');
    const r = applyIntent(t, { deliveryTarget: 'company' });
    expect(r.task).toEqual(t);
    expect(r.replies[0].text).toContain('A refund does not need a delivery address');
    expect(r.replies[0].quick?.map((q) => q.text)).toContain('Choose another plan');
  });
  it('going back home restores the earlier quote', () => {
    const toCompany = applyIntent(ready(), { deliveryTarget: 'company' }).task;
    const back = applyIntent(toCompany, { deliveryTarget: 'home' }).task;
    expect(plansKey(back)).toBe(plansKey(ready()));
  });
});

describe('state updates keep what the user already gave', () => {
  it('changing the item keeps symptoms and dates, drops a plan that is no longer eligible, and re-checks eligibility', () => {
    const t = setPlan(ready(), 'exchange');
    const u = setOrder(t, O2);                       // out of warranty: exchange not allowed
    expect(u.planId).toBeNull();
    expect(u.symptoms).toEqual(['one_side_silent']); expect(u.deadline).toBe('2026-11-16');
    expect(setOrder(setPlan(ready(), 'repair'), O2).planId).toBe('repair'); // repair still allowed -> kept
  });
  it('preference does not change the quote version (only the recommendation text)', () => {
    expect(plansKey(applyIntent(ready(), { preference: 'fastest' }).task)).toBe(plansKey(ready()));
  });
  it('choosing an ineligible plan is refused with the reason', () => {
    const r = applyIntent(ready('standard', { orderId: O2 }), { planChoice: 'refund' });
    expect(r.task.planId).toBeNull();
    expect(r.replies[0].text).toContain('Out of warranty');
  });
});

describe('staleness and submit readiness', () => {
  const full = (): TaskState => setPickup(setPlan(ready(), 'exchange'), { method: 'courier', date: '2026-11-12', slot: '09:00-12:00' });
  it('payload exists only when every requirement is met', () => {
    expect(payloadOf(ready())).toBeNull();
    expect(readiness(setPlan(ready(), 'exchange')).some((x) => x.includes('return method'))).toBe(true);
    const p = payloadOf(full())!;
    expect(p.planId).toBe('exchange');
    expect(p.delivery?.id).toBe('home-1'); expect(p.pickupAddr.id).toBe('home-1');
  });
  it('a full slot or unsupported pickup blocks readiness', () => {
    expect(readiness(setPickup(full(), { date: '2026-11-13', slot: '18:00-20:00' })).join()).toContain('Choose a pickup time slot'); // setPickup drops a full slot
    const stale = full(); // a slot that became full after it was chosen (state not produced by setPickup)
    expect(readiness({ ...stale, pickup: { ...stale.pickup, date: '2026-11-13', slot: '18:00-20:00' } }).join()).toContain('full');
    const remote = scenarioById('multi_company').addresses[2];
    expect(readiness({ ...full(), pickupAddr: remote }).join()).toContain('Courier pickup is not available');
  });
  it('a plans card goes stale after an address change; the confirm card after any change to what is submitted', () => {
    const t1 = setPlan(ready(), 'exchange');
    const plans: RMsg = { id: 'a1', role: 'agent', text: '', card: { type: 'plans', snapshot: t1 } };
    expect(cardLive([plans], 0, t1)).toBe(true);
    const t2 = applyIntent(t1, { deliveryTarget: 'company' }).task;
    expect(cardLive([plans], 0, t2)).toBe(false);
    const f = full();
    const confirm: RMsg = { id: 'a2', role: 'agent', text: '', card: { type: 'confirm', snapshot: f } };
    expect(cardLive([confirm], 0, f)).toBe(true);
    expect(cardLive([confirm], 0, setPickup(f, { slot: '14:00-18:00' }))).toBe(false);
    expect(confirmKey(f)).not.toBe(confirmKey(setPickup(f, { date: '2026-11-15' })));
  });
  it('only the newest card of a kind is live, and nothing is live after submission', () => {
    const f = full();
    const a: RMsg = { id: '1', role: 'agent', text: '', card: { type: 'orders', snapshot: f } };
    const b: RMsg = { id: '2', role: 'agent', text: '', card: { type: 'orders', snapshot: f } };
    expect(cardLive([a, b], 0, f)).toBe(false); expect(cardLive([a, b], 1, f)).toBe(true);
    const done = { ...f, submit: { status: 'done', record: {} as never } } as TaskState;
    expect(cardLive([a, b], 1, done)).toBe(false);
  });
  it('after submission a changed requirement goes to the change flow and the task is not modified', () => {
    const done = { ...full(), submit: { status: 'done', record: { id: 'AS-1' } as never } } as TaskState;
    const r = applyIntent(done, { deliveryTarget: 'home' });
    expect(r.task).toEqual(done);
    expect(r.replies[0].card?.type).toBe('change');
  });
});
