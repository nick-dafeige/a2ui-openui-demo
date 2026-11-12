import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Fail-closed paid-request ledger (modelled on the research repo's request_budget.py).
 * Default maximum is 0: paid calls stay disabled until a human sets `maximum_requests`.
 * Every attempt is reserved BEFORE sending and never refunded.
 */
export interface Ledger { maximum_requests: number; recorded_requests: number; reservations: { number: number; stage: string; at: string }[] }
export const DEFAULT_LEDGER = join(process.cwd(), 'evidence/MODEL_CALL_BUDGET.json');

export function reserve(stage: string, ledgerPath = DEFAULT_LEDGER, now = () => new Date()): number {
  const state: Ledger = existsSync(ledgerPath)
    ? JSON.parse(readFileSync(ledgerPath, 'utf8'))
    : { maximum_requests: 0, recorded_requests: 0, reservations: [] };
  if (!Number.isInteger(state.maximum_requests) || state.recorded_requests < 0 || state.recorded_requests > state.maximum_requests && state.maximum_requests !== 0)
    throw new Error('invalid_budget_ledger');
  if (state.recorded_requests >= state.maximum_requests) throw new Error('paid_request_budget_exhausted_or_not_authorised');
  state.recorded_requests += 1;
  state.reservations.push({ number: state.recorded_requests, stage, at: now().toISOString() });
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const tmp = `${ledgerPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, ledgerPath);
  return state.recorded_requests;
}
