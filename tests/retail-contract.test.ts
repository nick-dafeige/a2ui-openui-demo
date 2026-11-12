/** v0.5.0 Part A: business contract (stated time slot, opening hours, deadline-day wording). Expected values are hand-derived from data.ts. */
import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../src/retail/data.ts';
import { applyIntent } from '../src/retail/flow.ts';
import { parseIntentLocal, validateIntent } from '../src/retail/intent.ts';
import { appointmentProblem, appointmentSlots, marginText, normaliseSlot, quoteAll, recommend, slotWithinHours } from '../src/retail/rules.ts';
import { initialTask, nextNeed, readiness, setPickup, setPlan } from '../src/retail/state.ts';

const base = () => ({ ...initialTask(SCENARIOS[0]), orderId: 'RT-20260620-1001', symptoms: ['no_power' as const], deadline: '2026-11-20' });

describe('stated time slot reaches the task (no repeated click)', () => {
  it('normalises ranges and 12-hour wording to a bookable slot, and rejects unknown windows', () => {
    expect(normaliseSlot('14:00-18:00')).toBe('14:00-18:00');
    expect(normaliseSlot('between 2pm and 6pm')).toBeNull();            // "and" is not a range separator we claim to understand
    expect(normaliseSlot('2pm to 6pm')).toBe('14:00-18:00');
    expect(normaliseSlot('9am-12pm')).toBe('09:00-12:00');
    expect(normaliseSlot('15:00-16:00')).toBeNull();                      // not one of the bookable windows
  });
  it('parser reads date + slot + store from one sentence', () => {
    const i = parseIntentLocal('I will drop it off on Nov 13, 14:00-18:00');
    expect(i.pickupDate).toBe('2026-11-13'); expect(i.pickupSlot).toBe('14:00-18:00'); expect(i.returnMethod).toBe('store');
  });
  it('validateIntent accepts only the three real slots', () => {
    expect(validateIntent({ pickupSlot: '14:00-18:00' }).ok).toBe(true);
    expect(validateIntent({ pickupSlot: '13:00-14:00' }).ok).toBe(false);
  });
  it('one message with point, date and slot completes the appointment', () => {
    let t = setPlan(base(), 'exchange');
    t = applyIntent(t, { returnMethod: 'store' }, { noAsk: true }).task;
    const r = applyIntent(t, { servicePointId: 'sp-2', pickupDate: '2026-11-13', pickupSlot: '14:00-18:00' }, { noAsk: true });
    expect(r.task.pickup).toMatchObject({ servicePointId: 'sp-2', date: '2026-11-13', slot: '14:00-18:00' });
    expect(nextNeed(r.task)).toBe('confirm');
  });
});

describe('opening hours constrain appointments', () => {
  it('slotWithinHours', () => {
    expect(slotWithinHours('09:00-12:00', '10:00-21:00')).toBe(false);     // starts before it opens
    expect(slotWithinHours('14:00-18:00', '10:00-21:00')).toBe(true);
    expect(slotWithinHours('18:00-20:00', '09:00-18:00')).toBe(false);     // ends after it closes
  });
  it('sp-2 (10:00-21:00) never offers 09:00-12:00; free slots on Nov 13 are the other two (13th: third slot is full)', () => {
    expect(appointmentSlots('sp-2', null).map((s) => s.slot)).toEqual(['14:00-18:00', '18:00-20:00']);
    expect(appointmentSlots('sp-2', '2026-11-13').map((s) => [s.slot, s.ok])).toEqual([['14:00-18:00', true], ['18:00-20:00', false]]);
  });
  it('a slot outside opening hours is refused with the reason and does not complete the task', () => {
    let t = setPlan(base(), 'exchange');
    t = applyIntent(t, { returnMethod: 'store', servicePointId: 'sp-2', pickupDate: '2026-11-12' }, { noAsk: true }).task;
    const r = applyIntent(t, { pickupSlot: '09:00-12:00' }, { noAsk: true });
    expect(r.task.pickup.slot).toBeNull();
    expect(r.replies[0].text).toContain('outside New District Store (demo) opening hours (10:00-21:00)');
    expect(nextNeed(r.task)).toBe('dropdate');
    expect(appointmentProblem('sp-2', '2026-11-12', '09:00-12:00')).toContain('outside');
  });
  it('a booked slot is dropped, with a note, when the user then picks a point it does not fit', () => {
    let t = setPlan(base(), 'exchange');
    t = applyIntent(t, { returnMethod: 'store', servicePointId: 'sp-1', pickupDate: '2026-11-12' }, { noAsk: true }).task;   // walk-in point: slot not needed
    t = setPickup(t, { slot: '09:00-12:00' });
    const r = applyIntent(t, { servicePointId: 'sp-2' }, { noAsk: true });
    expect(r.task.pickup.slot).toBeNull();
    expect(r.replies[0].text).toContain('cannot be kept');
    expect(readiness(r.task).join()).toContain('needs an appointment');
  });
});

describe('deadline-day wording', () => {
  it('margin text never says "before" for zero spare days', () => {
    expect(marginText(0)).toBe('arrives on your deadline day');
    expect(marginText(2)).toBe('arrives in time, 2 days before your deadline');
    expect(marginText(1)).toBe('arrives in time, 1 day before your deadline');
    expect(marginText(-1)).toBe('misses your deadline by 1 day');
  });
  it('recommendation: exchange to a urban home address arrives Nov 15 (today Nov 10, ships Nov 11, +4); deadline Nov 15 reads "on your deadline day"', () => {
    const t = { ...base(), deadline: '2026-11-15' };
    const q = quoteAll({ orderId: t.orderId, deadline: t.deadline, delivery: t.delivery, pickupDate: null });
    expect(q.find((x) => x.plan === 'exchange')!.etaDate).toBe('2026-11-15');
    const text = recommend(q, t.deadline, 'cheapest').text;
    expect(text).toContain('on your Nov 15 deadline day');
    expect(text).not.toContain('before your Nov 15');
  });
});
