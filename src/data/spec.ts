/**
 * Hand-written demo-data specification. It is the independent oracle: records are
 * generated FROM these counts, and tests compare engine output with these counts
 * (plus expected.json), never with the generator's own output.
 */
export const REFERENCE = {
  referenceDate: '2026-11-10', // fixed "today" (Tuesday), UTC
  timeZone: 'UTC',
  weekStartsOn: 'monday',
  lastWeek: { start: '2026-11-02', end: '2026-11-08' }, // inclusive
  previousWeek: { start: '2026-10-26', end: '2026-11-01' },
} as const;

export interface WeekSpec {
  calls: number;
  answered: number;
  converted: number; // subset of answered
  noAnswer: number;
  busy: number;
  failed: number; // noAnswer+busy+failed === calls-answered
}
export interface CampaignSpec {
  id: string;
  name: string;
  scenario: 'improves' | 'declines' | 'flat' | 'no-previous' | 'no-records' | 'zero-answered' | 'small-sample';
  previous: WeekSpec | null;
  current: WeekSpec | null;
}

export const CAMPAIGNS: CampaignSpec[] = [
  { id: 'c1', name: 'Spring Renewal', scenario: 'improves',
    previous: { calls: 200, answered: 100, converted: 20, noAnswer: 60, busy: 25, failed: 15 },
    current:  { calls: 200, answered: 130, converted: 39, noAnswer: 40, busy: 20, failed: 10 } },
  { id: 'c2', name: 'Payment Reminder', scenario: 'declines',
    previous: { calls: 300, answered: 180, converted: 54, noAnswer: 70, busy: 30, failed: 20 },
    current:  { calls: 300, answered: 120, converted: 24, noAnswer: 110, busy: 45, failed: 25 } },
  { id: 'c3', name: 'Winback Offer', scenario: 'flat',
    previous: { calls: 150, answered: 75, converted: 15, noAnswer: 45, busy: 20, failed: 10 },
    current:  { calls: 150, answered: 75, converted: 15, noAnswer: 45, busy: 20, failed: 10 } },
  { id: 'c4', name: 'Survey Pilot', scenario: 'no-previous',
    previous: null,
    current:  { calls: 40, answered: 20, converted: 4, noAnswer: 10, busy: 6, failed: 4 } },
  { id: 'c5', name: 'Dormant Q3', scenario: 'no-records', previous: null, current: null },
  { id: 'c6', name: 'Tiny Sample Test', scenario: 'small-sample',
    previous: { calls: 10, answered: 8, converted: 2, noAnswer: 1, busy: 1, failed: 0 },
    current:  { calls: 10, answered: 3, converted: 1, noAnswer: 5, busy: 1, failed: 1 } },
  { id: 'c7', name: 'Dead Line Check', scenario: 'zero-answered',
    previous: { calls: 20, answered: 4, converted: 1, noAnswer: 8, busy: 5, failed: 3 },
    current:  { calls: 20, answered: 0, converted: 0, noAnswer: 12, busy: 5, failed: 3 } },
];
