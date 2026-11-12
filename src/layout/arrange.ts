import type { ComponentId, Layout } from './components.ts';

/**
 * Display order inside ONE report. Only components that report contains are shown; pinned ones come first
 * (in layout order), the rest follow in layout order. A pin never forces a component into a later reply (v0.2.0).
 */
export function arrange(layout: Layout, present: readonly ComponentId[]): ComponentId[] {
  const want = new Set(present);
  const items = layout.items.filter((i) => want.has(i.id));
  return [...items.filter((i) => i.pinned), ...items.filter((i) => !i.pinned)].map((i) => i.id);
}
