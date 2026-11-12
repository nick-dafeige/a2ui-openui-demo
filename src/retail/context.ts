import { RETAIL_TODAY, SERVICE_POINTS } from './data.ts';
import { orderById } from './rules.ts';
import { candidateOrders, nextNeed, type TaskState } from './state.ts';

/** Plain-text context for the model: what was shown and what the agent is waiting for. No secrets. */
export function contextFor(t: TaskState): string {
  const need = nextNeed(t);
  const lines = [`Agent is waiting for: ${need ?? 'nothing'}.`];
  lines.push('Orders shown to the user (position. id | name | warranty): ' + candidateOrders(t).map((o, n) => `${n + 1}. ${o.id} | ${o.name} | ${RETAIL_TODAY <= o.warrantyEnd ? 'in warranty' : 'out of warranty'}`).join('; '));
  if (need === 'servicepoint' || need === 'location') lines.push('Service points shown (position. id | name): ' + SERVICE_POINTS.map((s, n) => `${n + 1}. ${s.id} | ${s.name}`).join('; '));
  lines.push(`Known: item=${orderById(t.orderId)?.name ?? 'none'}; symptoms=${t.symptoms.join(',') || 'none'}; latest receive date=${t.deadline ?? 'none'}; plan=${t.planId ?? 'none'}; return method=${t.pickup.method ?? 'none'}.`);
  return lines.join('\n');
}
