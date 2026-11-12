import { describe, expect, it } from 'vitest';
import { arrange } from '../src/layout/arrange.ts';
import { defaultLayout } from '../src/layout/defaults.ts';
import { LAYOUT_STORAGE_KEY, loadLayout, parseLayout, saveLayout } from '../src/layout/parse.ts';
import type { Layout } from '../src/layout/components.ts';

const pin = (l: Layout, id: string, pinned = true): Layout => ({ ...l, items: l.items.map((i) => (i.id === id ? { ...i, pinned } : i)) });
const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };

describe('arrange', () => {
  it('shows only present components in layout order', () =>
    expect(arrange(defaultLayout(), ['campaign_table', 'calls_card'])).toEqual(['calls_card', 'campaign_table']));
  it('a pin never forces its component into a report that does not contain it (v0.2.0)', () =>
    expect(arrange(pin(defaultLayout(), 'answer_rate_card'), ['change_ranking'])).toEqual(['change_ranking']));
  it('pinned components stay at the top, ahead of earlier-ordered unpinned ones', () =>
    expect(arrange(pin(defaultLayout(), 'campaign_table'), ['calls_card', 'campaign_table', 'daily_trend'])).toEqual(['campaign_table', 'calls_card', 'daily_trend']));
});

describe('layout persistence (FR-28)', () => {
  it('round-trips through storage', () => {
    const s = memory(); const l = pin(defaultLayout(), 'answer_rate_card');
    expect(saveLayout(l, s)).toBe(true);
    expect(loadLayout(s)).toEqual(l);
  });
  it('falls back to the default on corrupt, partial or tampered data', () => {
    const s = memory();
    for (const bad of ['{not json', '{"version":1,"items":[]}', JSON.stringify({ version: 1, items: defaultLayout().items.map((i) => ({ ...i, accent: 'neon' })) }), 'null']) {
      s.m.set(LAYOUT_STORAGE_KEY, bad);
      expect(loadLayout(s)).toEqual(defaultLayout());
    }
  });
  it('parseLayout rejects duplicates and unknown ids', () => {
    const d = defaultLayout();
    expect(parseLayout({ ...d, items: [...d.items.slice(1), d.items[1]] })).toBeNull();
    expect(parseLayout({ ...d, items: d.items.map((i, n) => (n ? i : { ...i, id: 'rogue' })) })).toBeNull();
  });
  it('survives unavailable storage', () => expect(loadLayout({ getItem: () => { throw new Error('blocked'); } })).toEqual(defaultLayout()));
});
