/** Single source of truth for report components and the accent palette. */
export const COMPONENT_IDS = [
  'calls_card', 'answer_rate_card', 'conversion_card', 'daily_trend',
  'campaign_table', 'change_ranking', 'call_list', 'daily_call_volume',
] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

export const PALETTE = {
  brand: '#4c0eb6', green: '#16a34a', red: '#dc2626', amber: '#d97706', purple: '#9b72f0',
} as const;
export type AccentKey = keyof typeof PALETTE;

export type Width = 'half' | 'full';
export interface LayoutItem { id: ComponentId; width: Width; accent: AccentKey; pinned: boolean }
/** Display style only (NFR-5): never contains query conditions. Array order is display order. */
export interface Layout { version: 1; items: LayoutItem[] }
