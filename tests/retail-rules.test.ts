import { describe, expect, it } from 'vitest';
import { scenarioById } from '../src/retail/data.ts';
import { addDays, availableSlots, checkDeadline, checkDepart, diffDays, fullMonths, isPickupDateValid, quoteAll, quotePlan, recommend, slotAvailable, zoneOf, type QuoteInput } from '../src/retail/rules.ts';

// Expected values are hand-computed from src/retail/data.ts and the policy text (never taken from engine output).
const S = scenarioById('multi_company').addresses;
const HOME = S[0], C1 = S[1], C2 = S[2];
const O1 = 'RT-20260620-1001', O2 = 'RT-20250418-0733', O3 = 'RT-20261105-2210';
const input = (o: Partial<QuoteInput> = {}): QuoteInput => ({ orderId: O1, deadline: '2026-11-16', delivery: HOME, pickupDate: null, ...o });
const q = (plan: 'exchange' | 'repair' | 'refund', o: Partial<QuoteInput> = {}) => quotePlan(plan, input(o))!;

describe('dates and zones', () => {
  it('date helpers', () => {
    expect(addDays('2026-11-10', 1)).toBe('2026-11-11');
    expect(diffDays('2026-11-16', '2026-11-15')).toBe(1);
    expect(fullMonths('2026-06-20', '2026-11-10')).toBe(4);   // Jun20 -> Oct20 = 4; Nov 10 is before the 20th
    expect(fullMonths('2026-11-05', '2026-11-10')).toBe(0);
  });
  it('zones follow distance from the centre (50,50)', () => {
    expect([HOME, C1, C2].map(zoneOf)).toEqual(['urban', 'suburb', 'remote']); // 8.5, 20.6, 48.4
  });
});

describe('case 1: in warranty, exchange arrives in time', () => {
  it('exchange to home: free, dispatched 11-11, arrives 11-15, one day before the deadline', () => {
    const e = q('exchange');
    expect(e.eligible).toBe(true);
    expect(e.fees).toEqual({ serviceCents: 0, shippingCents: 0, totalCents: 0, refundCents: null });
    expect(e.etaDate).toBe('2026-11-15');
    expect(e.timing).toBe('on_time');
    expect(e.marginDays).toBe(1);
  });
  it('recommendation names the exchange and quotes both dates', () => {
    const r = recommend(quoteAll(input()), '2026-11-16', null);
    expect(r.planId).toBe('exchange');
    expect(r.text).toContain('Nov 15');
    expect(r.text).toContain('before your Nov 16 deadline');
  });
});

describe('case 2: repair is possible but too slow', () => {
  it('repair: pickup 11-11, at centre 11-12, done 11-17, home 11-19 -> late by 3 days', () => {
    const r = q('repair');
    expect(r.eligible).toBe(true);
    expect(r.etaDate).toBe('2026-11-19');
    expect(r.timing).toBe('late');
    expect(r.marginDays).toBe(-3);
    expect(r.pickupAssumed).toBe(true);
  });
  it('a later pickup date pushes the repair date out (11-13 -> 11-21)', () => {
    const r = q('repair', { pickupDate: '2026-11-13' });
    expect(r.etaDate).toBe('2026-11-21');
    expect(r.pickupAssumed).toBe(false);
  });
});

describe('case 3: refund works but does not give a usable device', () => {
  it('refund 20% usage deduction: 899.00 -> 719.20, arrives 11-18, never on_time', () => {
    const r = q('refund');
    expect(r.fees.refundCents).toBe(71920);
    expect(r.etaDate).toBe('2026-11-18');
    expect(r.timing).toBe('no_device');
    expect(r.needsDelivery).toBe(false);
  });
  it('is never the recommendation even when it is the only eligible plan', () => {
    const only = quoteAll(input({ orderId: O2 })).map((x) => (x.plan === 'repair' ? { ...x, eligible: false } : x));
    expect(recommend(only, '2026-11-16', null).planId).toBeNull();
  });
});

describe('case 4: company address changes cost and arrival', () => {
  it('suburb company: 5 transit days -> 11-16 (on the deadline day), shipping 10.00', () => {
    const e = q('exchange', { delivery: C1 });
    expect(e.etaDate).toBe('2026-11-16');
    expect(e.fees.shippingCents).toBe(1000);
    expect(e.timing).toBe('on_time');
    expect(e.marginDays).toBe(0);
  });
  it('remote company: 8 transit days -> 11-19, shipping 25.00, late', () => {
    const e = q('exchange', { delivery: C2 });
    expect(e.etaDate).toBe('2026-11-19');
    expect(e.fees.shippingCents).toBe(2500);
    expect(e.timing).toBe('late');
  });
  it('refund is unaffected by the delivery address', () => {
    expect(q('refund', { delivery: C2 })).toEqual(q('refund', { delivery: HOME }));
  });
});

describe('case 6: nothing meets the deadline', () => {
  const quotes = quoteAll(input({ deadline: '2026-11-13' }));
  it('no plan is on time and no recommendation is made', () => {
    expect(quotes.filter((x) => x.timing === 'on_time')).toEqual([]);
    const r = recommend(quotes, '2026-11-13', null);
    expect(r.planId).toBeNull();
    expect(r.text).toContain('No plan can get');
    expect(r.text).toContain('not recommending');
    expect(r.text).toContain('cannot provide a working device'); // refund is mentioned but not offered as a fix
  });
  it('without a deadline everything is "unknown" and nothing is recommended', () => {
    const u = quoteAll(input({ deadline: null }));
    expect(u.filter((x) => x.plan !== 'refund').every((x) => x.timing === 'unknown')).toBe(true);
    expect(recommend(u, null, null).planId).toBeNull();
  });
});

describe('eligibility', () => {
  it('out of warranty: exchange and refund refused with the reason, repair costs 129.00 (home is urban: no shipping)', () => {
    const [ex, rp, rf] = quoteAll(input({ orderId: O2 }));
    expect(ex.eligible).toBe(false); expect(ex.reason).toBe('Out of warranty (expired 2026-04-18)');
    expect(rf.eligible).toBe(false);
    expect(rp.eligible).toBe(true); expect(rp.fees.serviceCents).toBe(12900); expect(rp.fees.totalCents).toBe(12900);
  });
  it('no stock: exchange refused; refund within the first month has no deduction', () => {
    const [ex, , rf] = quoteAll(input({ orderId: O3 }));
    expect(ex.eligible).toBe(false); expect(ex.reason).toBe('Out of stock, so exchange is not possible');
    expect(rf.fees.refundCents).toBe(49900);
  });
  it('unknown order -> no quotes', () => expect(quoteAll(input({ orderId: 'nope' }))).toEqual([]));
});

describe('preference only matters when several plans make it', () => {
  const base = input({ delivery: C1, deadline: '2026-11-21' }); // exchange 11-16 / 10.00, repair 11-20 / 0.00 (in-warranty repair has no return shipping)
  const quotes = quoteAll(base);
  it('default and cheapest -> repair (0.00); fastest -> exchange', () => {
    expect(recommend(quotes, base.deadline, null).planId).toBe('repair');
    expect(recommend(quotes, base.deadline, 'cheapest').planId).toBe('repair');
    expect(recommend(quotes, base.deadline, 'fastest').planId).toBe('exchange');
  });
});

describe('determinism', () => {
  it('the same input always gives the same quote', () => {
    expect(JSON.stringify(quoteAll(input({ delivery: C1 })))).toBe(JSON.stringify(quoteAll(input({ delivery: C1 }))));
  });
});

describe('validation and availability', () => {
  it('deadline must be after today and not after departure', () => {
    expect(checkDeadline('2026-11-10', null).ok).toBe(false);
    expect(checkDeadline('2026-11-16', '2026-11-15').ok).toBe(false);
    expect(checkDeadline('2026-11-16', '2026-11-17').ok).toBe(true);
    expect(checkDeadline('2026-13-40', null).ok).toBe(false);
    expect(checkDepart('2026-11-10').ok).toBe(false);
  });
  it('pickup window is tomorrow..+7 and slots follow the fixed rule', () => {
    expect(isPickupDateValid('2026-11-10')).toBe(false);
    expect(isPickupDateValid('2026-11-11')).toBe(true);
    expect(isPickupDateValid('2026-11-17')).toBe(true);
    expect(isPickupDateValid('2026-11-18')).toBe(false);
    expect(slotAvailable('2026-11-13', '18:00-20:00')).toBe(false); // (13+2)%5==0
    expect(slotAvailable('2026-11-14', '14:00-18:00')).toBe(false); // (14+1)%5==0
    expect(availableSlots('2026-11-12')).toEqual(['09:00-12:00', '14:00-18:00', '18:00-20:00']);
    expect(availableSlots('2026-11-13')).toEqual(['09:00-12:00', '14:00-18:00']);
    expect(availableSlots('2026-11-30')).toEqual([]);
  });
});
