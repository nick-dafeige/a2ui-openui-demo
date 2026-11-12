/** Synthetic retail after-sales data (demo only). Nothing here is real: names, phones, addresses are placeholders. */

export const RETAIL_TODAY = '2026-11-10'; // fixed reference date (Tuesday), same as the reporting demo

export type PlanId = 'exchange' | 'repair' | 'refund';
export type SymptomId = 'no_power' | 'one_side_silent' | 'charging' | 'unsure';
export type Zone = 'urban' | 'suburb' | 'remote';
export type ScenarioId = 'standard' | 'no_company' | 'multi_company' | 'submit_fail';

export const PLAN_IDS: readonly PlanId[] = ['exchange', 'repair', 'refund'];
export const PLAN_LABEL: Record<PlanId, string> = { exchange: 'Exchange', repair: 'Repair', refund: 'Refund' };
export const SYMPTOMS: { id: SymptomId; label: string }[] = [
  { id: 'no_power', label: 'Won\'t power on' },
  { id: 'one_side_silent', label: 'One side silent' },
  { id: 'charging', label: 'Charging problem' },
  { id: 'unsure', label: 'Not sure what\'s wrong' },
];

export interface Order {
  id: string; sku: string; name: string; category: 'headphones' | 'speaker';
  purchased: string; warrantyEnd: string; priceCents: number;
}
export const ORDERS: Order[] = [
  { id: 'RT-20260620-1001', sku: 'aurora-pro', name: 'Aurora Pro Wireless ANC Headphones', category: 'headphones', purchased: '2026-06-20', warrantyEnd: '2027-06-20', priceCents: 89900 },
  { id: 'RT-20250418-0733', sku: 'aurora-lite', name: 'Aurora Lite Bluetooth Headphones', category: 'headphones', purchased: '2025-04-18', warrantyEnd: '2026-04-18', priceCents: 39900 },
  { id: 'RT-20261105-2210', sku: 'nimbus', name: 'Nimbus Bluetooth Speaker', category: 'speaker', purchased: '2026-11-05', warrantyEnd: '2027-11-05', priceCents: 49900 },
];
export const STOCK: Record<string, number> = { 'aurora-pro': 12, 'aurora-lite': 3, nimbus: 0 };

export interface Address {
  id: string; kind: 'home' | 'company' | 'custom'; label: string;
  recipient: string; phone: string; detail: string; floor: string; x: number; y: number; // x,y on the 0-100 schematic map
}
const home: Address = { id: 'home-1', kind: 'home', label: 'Home', recipient: 'Demo User', phone: '000-0000-0001', detail: '1 Example Rd, Example District, Demo City (demo address)', floor: 'Floor 3, Apt 301', x: 44, y: 56 };
const company1: Address = { id: 'company-1', kind: 'company', label: 'Company · Example Tower', recipient: 'Demo User', phone: '000-0000-0002', detail: '8 Innovation Rd, Example New District, Demo City (demo address)', floor: 'Floor 12, Room 1208', x: 68, y: 40 };
const company2: Address = { id: 'company-2', kind: 'company', label: 'Company · Remote Branch', recipient: 'Demo User', phone: '000-0000-0003', detail: '66 Industry Rd, Outer Park, Demo City (demo address)', floor: 'Floor 2, Room 201', x: 88, y: 80 };

export interface Scenario { id: ScenarioId; label: string; addresses: Address[]; failFirstSubmit: boolean }
export const SCENARIOS: Scenario[] = [
  { id: 'standard', label: 'Standard user (1 company address)', addresses: [home, company1], failFirstSubmit: false },
  { id: 'no_company', label: 'No company address', addresses: [home], failFirstSubmit: false },
  { id: 'multi_company', label: 'Several company addresses', addresses: [home, company1, company2], failFirstSubmit: false },
  { id: 'submit_fail', label: 'First submit fails (retry demo)', addresses: [home, company1], failFirstSubmit: true },
];
export const scenarioById = (id: string): Scenario => SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];

export interface ServicePoint { id: string; name: string; detail: string; x: number; y: number; supports: PlanId[]; hours: string; appointment: boolean }
export const SERVICE_POINTS: ServicePoint[] = [
  { id: 'sp-1', name: 'Central Service Center (demo)', detail: '5 Service Rd, Example District, Demo City', x: 52, y: 48, supports: ['exchange', 'repair', 'refund'], hours: '09:00-20:00', appointment: false },
  { id: 'sp-2', name: 'New District Store (demo)', detail: '20 Innovation Rd, Example New District, Demo City', x: 64, y: 36, supports: ['exchange', 'repair'], hours: '10:00-21:00', appointment: true },
  { id: 'sp-3', name: 'West Pickup Point (demo)', detail: '3 Bianmin Rd, West District, Demo City', x: 30, y: 62, supports: ['refund'], hours: '09:00-18:00', appointment: false },
];

export const PICKUP_SLOTS = ['09:00-12:00', '14:00-18:00', '18:00-20:00'] as const;

export const PLAN_TERMS: Record<PlanId, string[]> = {
  exchange: ['In-warranty hardware faults can be exchanged, subject to stock.', 'The replacement ships first; the old unit must be sent back within 7 days of delivery.', 'Shipping depends on the delivery area (urban 0, suburban 10, remote 25).', 'Estimated dates are estimates, not delivery guarantees.'],
  repair: ['In warranty: no service fee and no return shipping. Out of warranty: 129 service fee plus area-based return shipping.', 'The repair center receives the unit 1 day after pickup, repairs it in about 5 days, then ships it to the delivery address.', 'Dates move with the pickup date and are estimates, not delivery guarantees.'],
  refund: ['In-warranty faulty items can be refunded; 5% is deducted per full month of use, up to 40%.', 'The refund is paid after the item is returned and inspected, about 7 days after pickup.', 'A refund does not give you a working device, so it does not solve a "need it for my trip" request.'],
};
