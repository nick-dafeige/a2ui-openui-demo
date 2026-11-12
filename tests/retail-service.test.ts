import { describe, expect, it } from 'vitest';
import { scenarioById } from '../src/retail/data.ts';
import { CaseStore, caseProgress, parsePayload, submitCase } from '../src/retail/service.ts';
import { initialTask, payloadOf, setPickup, setPlan, type SubmitPayload } from '../src/retail/state.ts';

const task = (sc = 'standard', plan: 'exchange' | 'repair' | 'refund' = 'exchange') =>
  setPickup(setPlan({ ...initialTask(scenarioById(sc as 'standard')), orderId: 'RT-20260620-1001', symptoms: ['no_power'], deadline: '2026-11-16' }, plan), { method: 'courier', date: '2026-11-12', slot: '14:00-18:00' });
const payload = (sc = 'standard', plan: 'exchange' | 'repair' | 'refund' = 'exchange') => payloadOf(task(sc, plan))!;
const send = (s: CaseStore, p: unknown, key = 'sess:k1', sc = 'standard', confirmed: unknown = true) => submitCase(s, { key, scenario: sc, payload: p, confirmed });

describe('submit service', () => {
  it('creates one case from a confirmed, valid payload; the receipt equals the confirmed content', () => {
    const s = new CaseStore(); const p = payload();
    const r = send(s, p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.id).toBe('AS-20261110-0001');
    expect(r.record.planId).toBe('exchange');
    expect(r.record.delivery).toEqual(p.delivery); expect(r.record.pickupAddr).toEqual(p.pickupAddr); expect(r.record.pickup).toEqual(p.pickup);
    expect(r.record.etaDate).toBe('2026-11-15'); expect(r.record.totalCents).toBe(0);
    expect(s.byId.size).toBe(1);
  });
  it('without an explicit confirmation nothing is created', () => {
    const s = new CaseStore();
    const r = send(s, payload(), 'sess:k1', 'standard', null);
    expect(r.ok).toBe(false); expect(!r.ok && r.created).toBe(false);
    expect(s.byId.size).toBe(0);
  });
  it('duplicate clicks (same key) and a re-send of identical content yield exactly one case', () => {
    const s = new CaseStore(); const p = payload();
    const a = send(s, p, 'sess:k1'), b = send(s, p, 'sess:k1'), c = send(s, p, 'sess:other');
    const elsewhere = send(s, p, 'other-session:k1');            // another session is a different customer: its own case
    expect(elsewhere.ok && elsewhere.duplicate).toBe(false);
    expect([a, b, c].every((x) => x.ok)).toBe(true);
    expect(s.byId.size).toBe(2);
    expect(b.ok && b.duplicate).toBe(true);
    expect(a.ok && b.ok && c.ok && new Set([a.record.id, b.record.id, c.record.id]).size).toBe(1);
  });
  it('a quote that changed since confirmation is rejected and creates nothing', () => {
    const s = new CaseStore();
    const r = send(s, { ...payload(), quoteFingerprint: '00000000' });
    expect(!r.ok && r.code).toBe('quote_changed'); expect(s.byId.size).toBe(0);
  });
  it('re-validates the server side: tampered address zone, bad slot and ineligible plans are refused', () => {
    const s = new CaseStore(); const p = payload();
    expect(!send(s, { ...p, delivery: { ...p.delivery!, x: 90, y: 90 } }, 'key-a').ok).toBe(true); // moves the address to the remote zone -> quote differs
    expect(!send(s, { ...p, pickup: { ...p.pickup, slot: '09:00-12:00', date: '2026-11-30' } }, 'key-b').ok).toBe(true);
    const o2 = { ...p, orderId: 'RT-20250418-0733' };
    const r = send(s, o2, 'key-c'); expect(!r.ok && r.code).toBe('not_eligible');
    expect(s.byId.size).toBe(0);
  });
  it('malformed bodies never throw and never create', () => {
    const s = new CaseStore();
    for (const bad of [null, 'x', {}, { ...payload(), planId: 'gift' }, { ...payload(), symptoms: ['x'] }, { ...payload(), pickupAddr: null }]) expect(send(s, bad, 'key-bad').ok).toBe(false);
    expect(parsePayload(payload() as SubmitPayload)).not.toBeNull();
    expect(send(s, payload(), 'x').ok).toBe(false); // key too short
    expect(s.byId.size).toBe(0);
  });
  it('failure scenario: first attempt fails WITHOUT creating, the safe retry (same key) creates exactly one', () => {
    const s = new CaseStore(); const p = payload('submit_fail');
    const f = send(s, p, 'sess:k9', 'submit_fail');
    expect(!f.ok && f.code).toBe('service_unavailable'); expect(!f.ok && f.created).toBe(false); expect(s.byId.size).toBe(0);
    const ok = send(s, p, 'sess:k9', 'submit_fail'); const again = send(s, p, 'sess:k9', 'submit_fail');
    expect(ok.ok && again.ok && ok.record.id === again.record.id).toBe(true); expect(s.byId.size).toBe(1);
  });
  it('refund keeps the refund amount and has no delivery address', () => {
    const s = new CaseStore(); const r = send(s, payload('standard', 'refund'));
    expect(r.ok && r.record.refundCents).toBe(71920); expect(r.ok && r.record.delivery).toBeNull();
  });
  it('progress comes from the stored record only', () => {
    const s = new CaseStore(); const r = send(s, payload());
    const id = r.ok ? r.record.id : '';
    const p = caseProgress(s, id); expect(p.ok && p.lines[0]).toContain(id);
    expect(caseProgress(s, 'AS-NOPE').ok).toBe(false);
  });
});
