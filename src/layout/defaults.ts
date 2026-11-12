import type { ComponentId, Layout, LayoutItem } from './components.ts';
import { COMPONENT_IDS } from './components.ts';

const HALF = new Set<ComponentId>(['calls_card', 'answer_rate_card', 'conversion_card']);
const ACCENT: Record<ComponentId, LayoutItem['accent']> = {
  calls_card: 'brand', answer_rate_card: 'brand', conversion_card: 'green', daily_trend: 'brand', daily_call_volume: 'purple',
  campaign_table: 'amber', change_ranking: 'red', call_list: 'amber',
};
export const defaultLayout = (): Layout => ({
  version: 1,
  items: COMPONENT_IDS.map((id) => ({ id, width: HALF.has(id) ? 'half' : 'full', accent: ACCENT[id], pinned: false })),
});
