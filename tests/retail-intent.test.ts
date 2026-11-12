import { describe, expect, it } from 'vitest';
import { ORDERS } from '../src/retail/data.ts';
import { interpretMessage, parseIntentLocal, validateIntent } from '../src/retail/intent.ts';

describe('local fallback parser', () => {
  it('the demo opening: headphones, vague "next week", NO guessed dates', () => {
    const i = parseIntentLocal('My headphones are broken and I need them for a business trip next week. Please help.');
    expect(i.orderHint).toBe('headphones');
    expect(i.tripNextWeek).toBe(true);
    expect(i.deadline).toBeUndefined();
    expect(i.departDate).toBeUndefined();
  });
  it('concrete dates keep departure and latest-receive apart', () => {
    const i = parseIntentLocal('I leave on Nov 17, and I need them delivered by Nov 16');
    expect(i.departDate).toBe('2026-11-17');
    expect(i.deadline).toBe('2026-11-16');
    expect(i.tripNextWeek).toBeUndefined();
    expect(parseIntentLocal('latest receive date 2026-11-16').deadline).toBe('2026-11-16');
  });
  it('addresses, preference, symptoms, plan choice, terms', () => {
    expect(parseIntentLocal('Please ship it to my company').deliveryTarget).toBe('company');
    expect(parseIntentLocal('Ship it to my home instead').deliveryTarget).toBe('home');
    expect(parseIntentLocal('Fastest first').preference).toBe('fastest');
    expect(parseIntentLocal('Lowest cost first').preference).toBe('cheapest');
    expect(parseIntentLocal("The left earbud has no sound and it won't power on").symptoms).toEqual(['no_power', 'one_side_silent']);
    expect(parseIntentLocal('There is a charging problem').symptoms).toEqual(['charging']);
    expect(parseIntentLocal('I choose the exchange').planChoice).toBe('exchange');
    expect(parseIntentLocal('Can I get a refund?').planChoice).toBeUndefined(); // a question is not a choice
    expect(parseIntentLocal('View plan terms').showTerms).toBe(true);
    expect(parseIntentLocal('Another order').changeOrder).toBe(true);
  });
  it('a few Chinese phrases still work as input', () => {
    expect(parseIntentLocal('寄到公司').deliveryTarget).toBe('company');
    expect(parseIntentLocal('我买的耳机坏了，下周出差要用').tripNextWeek).toBe(true);
  });
  it('never produces a submit-like action', () => {
    expect(Object.keys(parseIntentLocal('Confirm and submit, please submit it for me')).length).toBe(0);
  });
});

describe('new in the conversational flow', () => {
  const orders = ORDERS.filter((o) => o.category === 'headphones');
  it('"the first one" / "the second one" / a product word resolve against what was shown', () => {
    expect(parseIntentLocal('The first one, the left side has no sound', { orders, expect: 'order' })).toMatchObject({ orderId: 'RT-20260620-1001', symptoms: ['one_side_silent'] });
    expect(parseIntentLocal('the second one', { orders, expect: 'order' }).orderId).toBe('RT-20250418-0733');
    expect(parseIntentLocal('the Lite please', { orders }).orderId).toBe('RT-20250418-0733');
    expect(parseIntentLocal('Fastest first', { orders, expect: 'order' }).orderId).toBeUndefined();   // "first" here is not an ordinal
  });
  it('drop-off wishes, addresses and locations', () => {
    expect(parseIntentLocal('I would like to drop-off, give me the address')).toMatchObject({ returnMethod: 'store', wantsAddress: true });
    expect(parseIntentLocal("I'll take it to a store myself").returnMethod).toBe('store');
    expect(parseIntentLocal('旧耳机我自己拿去寄，给我地址')).toMatchObject({ returnMethod: 'store', wantsAddress: true });
    expect(parseIntentLocal('Please have a courier pick it up').returnMethod).toBe('courier');
    expect(parseIntentLocal('Near my company')).toMatchObject({ locationPref: 'company' });
    expect(parseIntentLocal('drop off near my company').deliveryTarget).toBeUndefined();            // "near" is a search place, not a delivery address
    expect(parseIntentLocal('the central one', { expect: 'servicepoint' }).servicePointId).toBe('sp-1');
  });
  it('dates take their role from the words around them or from the question that was just asked', () => {
    expect(parseIntentLocal("I'll bring it in on Nov 13").pickupDate).toBe('2026-11-13');
    expect(parseIntentLocal('Nov 16', { expect: 'deadline' }).deadline).toBe('2026-11-16');
    expect(parseIntentLocal('Nov 13', { expect: 'pickupdate' }).pickupDate).toBe('2026-11-13');
    expect(parseIntentLocal('Nov 13').pickupDate).toBeUndefined();                                    // a bare date with no question open means nothing
  });
  it('only real month names are dates ("margin 0", "market 5" are not)', () => {
    expect(parseIntentLocal('latest receive margin 0 market 5', { expect: 'deadline' }).deadline).toBeUndefined();
    expect(parseIntentLocal('Nov 16', { expect: 'deadline' }).deadline).toBe('2026-11-16');
    expect(parseIntentLocal('November 16th', { expect: 'deadline' }).deadline).toBe('2026-11-16');
  });
  it('plan choice is judged per sentence; questions are not choices', () => {
    expect(parseIntentLocal('Exchange please').planChoice).toBe('exchange');
    expect(parseIntentLocal('Repair is fine. Where can I drop it off?').planChoice).toBe('repair');
    expect(parseIntentLocal('Can I get a refund?').planChoice).toBeUndefined();
  });
  it('validateIntent knows the new keys and rejects invented ids', () => {
    expect(validateIntent({ returnMethod: 'store', servicePointId: 'sp-1', pickupDate: '2026-11-13' }).ok).toBe(true);
    expect(validateIntent({ orderId: 'RT-FAKE' })).toEqual({ ok: false, reason: 'bad_orderId' });
    expect(validateIntent({ servicePointId: 'sp-99' })).toEqual({ ok: false, reason: 'bad_servicePointId' });
    expect(validateIntent({ returnMethod: 'drone' })).toEqual({ ok: false, reason: 'bad_returnMethod' });
  });
});

describe('validateIntent (untrusted model JSON)', () => {
  it('accepts a clean intent', () => expect(validateIntent({ orderHint: 'headphones', deadline: '2026-11-16' })).toEqual({ ok: true, intent: { orderHint: 'headphones', deadline: '2026-11-16' } }));
  it.each([
    [{ price: 100 }, 'unknown_key:price'],
    [{ deadline: '2026-02-30' }, 'bad_deadline'],
    [{ deadline: 'next week' }, 'bad_deadline'],
    [{ planChoice: 'upgrade' }, 'bad_planChoice'],
    [{ symptoms: ['no_power', 'on_fire'] }, 'bad_symptoms'],
    [{ preference: 'cheap' }, 'bad_preference'],
    [{ caseId: 'AS-1' }, 'unknown_key:caseId'],
    [[], 'not_object'],
  ])('rejects %j', (raw, reason) => expect(validateIntent(raw)).toEqual({ ok: false, reason }));
});

describe('interpretMessage with an injected model', () => {
  it('valid JSON -> intent labelled live', async () => {
    const o = await interpretMessage('x', async () => '```json\n{"deliveryTarget":"company"}\n```');
    expect(o).toEqual({ kind: 'intent', intent: { deliveryTarget: 'company' }, source: 'live' });
  });
  it('failures are reported, never turned into an intent', async () => {
    expect((await interpretMessage('x', async () => { throw new Error('http_503'); })).kind).toBe('failed');
    expect((await interpretMessage('x', async () => 'nope')).kind).toBe('failed');
    expect(await interpretMessage('x', async () => '{"fee":0}')).toEqual({ kind: 'failed', reason: 'invalid_model_intent:unknown_key:fee' });
  });
});
