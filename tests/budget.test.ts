import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reserve } from '../src/ai/budget.ts';

const tmp = () => join(mkdtempSync(join(tmpdir(), 'budget-')), 'ledger.json');
describe('paid-call budget', () => {
  it('refuses when no ledger exists (default maximum is 0)', () => expect(() => reserve('x', tmp())).toThrow('not_authorised'));
  it('reserves up to the maximum and then refuses; counts are durable', () => {
    const p = tmp();
    writeFileSync(p, JSON.stringify({ maximum_requests: 2, recorded_requests: 0, reservations: [] }));
    expect(reserve('a', p)).toBe(1);
    expect(reserve('b', p)).toBe(2);
    expect(() => reserve('c', p)).toThrow('exhausted');
    expect(JSON.parse(readFileSync(p, 'utf8')).recorded_requests).toBe(2);
  });
});
