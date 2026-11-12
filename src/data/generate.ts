import { CAMPAIGNS, REFERENCE, type WeekSpec } from './spec.ts';

export type Outcome = 'connected' | 'no_answer' | 'busy' | 'failed';
export interface CallRecord {
  id: string;
  campaignId: string;
  startedAt: string; // ISO-8601 UTC
  outcome: Outcome;
  converted: boolean;
  phone: string; // synthetic, fictional-range numbers only
  durationSec: number;
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Deterministic: no randomness, so the dataset is identical on every run. */
function weekRecords(campaignId: string, weekStart: string, w: WeekSpec, seq: { n: number }): CallRecord[] {
  const outcomes: Outcome[] = [
    ...Array(w.answered).fill('connected'),
    ...Array(w.noAnswer).fill('no_answer'),
    ...Array(w.busy).fill('busy'),
    ...Array(w.failed).fill('failed'),
  ];
  if (outcomes.length !== w.calls) throw new Error(`spec inconsistent for ${campaignId} ${weekStart}`);
  let convertedLeft = w.converted;
  return outcomes.map((outcome, i) => {
    seq.n += 1;
    const day = addDays(weekStart, i % 7);
    const hour = 9 + ((i * 7) % 9); // 09..17
    const minute = (i * 13) % 60;
    const converted = outcome === 'connected' && convertedLeft > 0 ? (convertedLeft--, true) : false;
    return {
      id: `call-${String(seq.n).padStart(5, '0')}`,
      campaignId,
      startedAt: `${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`,
      outcome,
      converted,
      phone: `+1-555-01${String(seq.n % 100).padStart(2, '0')}`,
      durationSec: outcome === 'connected' ? 40 + ((i * 17) % 200) : 0,
    };
  });
}

export function generateCalls(): CallRecord[] {
  const seq = { n: 0 };
  const out: CallRecord[] = [];
  for (const c of CAMPAIGNS) {
    if (c.previous) out.push(...weekRecords(c.id, REFERENCE.previousWeek.start, c.previous, seq));
    if (c.current) out.push(...weekRecords(c.id, REFERENCE.lastWeek.start, c.current, seq));
  }
  return out;
}
