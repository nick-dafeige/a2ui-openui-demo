/**
 * Validation of a model-written OpenUI Lang program BEFORE anything renders (v0.5.0). The renderer silently drops unknown
 * components and unresolved references, so this module rejects them explicitly: library membership, props, binding ids and
 * kinds, enumerated fields, legal actions, structure limits, figures in wording, and whether the program offers what the
 * application is waiting for. Pure and browser-safe.
 */
import { createParser, type ElementNode } from '@openuidev/react-lang';
import { validateIntent } from '../intent.ts';
import { SERVICE_POINTS } from '../data.ts';
import { isPickupDateValid, slotAvailable, appointmentProblem } from '../rules.ts';
import type { Need, TaskState } from '../state.ts';
import { guardAnswer, type Allowed } from '../turn.ts';
import type { Binding, EvidenceBundle } from './bundle.ts';
import { APPLY_FIELDS, type Control } from './events.ts';
import { COMPONENT_NAMES, library } from './library.tsx';

export const LIMITS = { chars: 7000, nodes: 40, depth: 4, inputs: 6, textChars: 1400 };
export interface LangCheck { ok: boolean; errors: string[]; warnings: string[]; program: string; controls: Control[]; components: string[]; texts: string[] }
export interface CheckContext { bundle: EvidenceBundle; state: TaskState; need: Need | null; requireNeed: boolean; allowed: Allowed }

const parser = createParser(library.toJSONSchema() as never);
export const stripFences = (raw: string): string => raw.trim().replace(/^```[a-zA-Z-]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();

const kindOf = (b: Binding | undefined, ref: string): string => (!b ? `missing(${ref})` : b.kind);
type Props = Record<string, unknown>;

/** What the application still needs from the user, in terms of controls. Empty when nothing can be asked (confirm / blocked). */
export function requiredControls(need: Need | null, t: TaskState): { id: string; label: string; has: (c: Control[]) => boolean }[] {
  const sel = (f: string) => (c: Control[]) => c.some((x) => (x.kind === 'select' && x.field === f) || (x.kind === 'apply' && x.field === ({ returnMethod: 'returnMethod', locationPref: 'locationPref', plan: 'planChoice', servicePoint: 'servicePointId' } as Record<string, string>)[f]));
  const dateCtl = (f: 'pickupDate' | 'deadline') => (c: Control[]) => c.some((x) => (x.kind === 'date' && x.field === f) || (x.kind === 'form' && x.fields.includes(f)));
  const slotCtl = (c: Control[]) => c.some((x) => x.kind === 'slot' || (x.kind === 'form' && x.fields.includes('pickupSlot')));
  const out: { id: string; label: string; has: (c: Control[]) => boolean }[] = [];
  switch (need) {
    case 'order': out.push({ id: 'order', label: 'a SingleChoice(order, ...) of the orders', has: sel('order') }); break;
    case 'symptoms': out.push({ id: 'symptoms', label: 'a MultiChoice(symptoms, ...)', has: (c) => c.some((x) => x.kind === 'multi') }); break;
    case 'deadline': out.push({ id: 'deadline', label: 'a DatePicker(deadline)', has: dateCtl('deadline') }); break;
    case 'plan': out.push({ id: 'plan', label: 'a SingleChoice(plan, ...) of the plans', has: sel('plan') }); break;
    case 'method': out.push({ id: 'method', label: 'a SingleChoice(returnMethod, ...)', has: sel('returnMethod') }); break;
    case 'location': out.push({ id: 'location', label: 'a SingleChoice(locationPref, ...)', has: sel('locationPref') }); break;
    case 'servicepoint': out.push({ id: 'servicepoint', label: 'a SingleChoice(servicePoint, ...) of the service points', has: sel('servicePoint') }); break;
    case 'dropdate': case 'pickup': {
      const k = t.pickup; const sp = SERVICE_POINTS.find((s) => s.id === k.servicePointId);
      const dateMissing = !isPickupDateValid(k.date);
      const slotMissing = need === 'pickup' ? !k.slot || !!(k.date && !slotAvailable(k.date, k.slot)) : !!sp?.appointment && (!k.slot || !!appointmentProblem(sp.id, k.date, k.slot));
      if (dateMissing) out.push({ id: 'pickupDate', label: 'a DatePicker(pickupDate) (alone, or in a Form)', has: dateCtl('pickupDate') });
      if (slotMissing) out.push({ id: 'pickupSlot', label: 'a TimeSlotPicker (alone, or in a Form)', has: slotCtl });
      break;
    }
    default: break;   // confirm / null: the application shows its own confirmation card
  }
  return out;
}

export function checkLang(raw: string, ctx: CheckContext): LangCheck {
  const program = stripFences(raw);
  const errors: string[] = [], warnings: string[] = [], controls: Control[] = [], texts: string[] = [], components: string[] = [];
  const out = (): LangCheck => ({ ok: errors.length === 0, errors, warnings, program, controls, components, texts });
  if (!program) { errors.push('empty_program'); return out(); }
  if (program.length > LIMITS.chars) { errors.push(`program_too_long:${program.length}`); return out(); }
  if (/\b(Query|Mutation)\s*\(|@[A-Za-z]+\s*\(|\$[A-Za-z_]/.test(program.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) errors.push('unsupported_feature: Query/Mutation/@actions/$variables are not available in this library');
  // constructors are looked for OUTSIDE string literals: "your Home (Urban) address" in a Text is words, not a component
  const code = program.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (const m of code.matchAll(/(?:^|[=\[,(\s])([A-Z][A-Za-z0-9]*)\s*\(/gm)) if (!COMPONENT_NAMES.includes(m[1])) errors.push(`unknown_component:${m[1]}`);
  const res = parser.parse(program);
  if (res.meta.incomplete) errors.push('incomplete_program');
  for (const u of res.meta.unresolved) errors.push(`unresolved_reference:${u}`);
  for (const o of res.meta.orphaned) errors.push(`unreferenced_statement:${o} (it would be silently dropped; put it in a parent's children or remove it)`);
  for (const e of res.meta.errors) errors.push(`${e.component ?? 'program'}${e.path ?? ''}: ${e.message}`);
  if (!res.root) { errors.push('no_root'); return out(); }
  if (res.root.typeName !== 'Stack') errors.push(`root_must_be_Stack:${res.root.typeName}`);

  let nodes = 0, inputs = 0, textChars = 0;
  const seenFields = new Set<string>();
  const addText = (s: unknown) => { if (typeof s === 'string' && s) { texts.push(s); textChars += s.length; } };
  const checkRef = (ref: unknown, prefix: string, kinds: string[], at: string): Binding | undefined => {
    if (typeof ref !== 'string' || !ref.startsWith(prefix)) { errors.push(`${at}: ref must be a binding starting with "${prefix}" but got ${JSON.stringify(ref)}`); return undefined; }
    const b = ctx.bundle.bindings[ref];
    if (!b) { errors.push(`${at}: unknown binding "${ref}" (not in BINDINGS)`); return undefined; }
    if (!kinds.includes(b.kind)) { errors.push(`${at}: binding "${ref}" is a ${kindOf(b, ref)}, not a ${kinds.join('/')}`); return undefined; }
    return b;
  };
  const walk = (n: unknown, depth: number): void => {
    if (Array.isArray(n)) { n.forEach((x) => walk(x, depth)); return; }
    if (!n || typeof n !== 'object' || (n as ElementNode).type !== 'element') return;
    const el = n as ElementNode; const p = el.props as Props; const at = el.typeName;
    nodes++; components.push(at);
    // the parser does not enforce array sizes or string lengths from the schema: do it here
    const size = (k: string, min: number, max: number) => { const n = Array.isArray(p[k]) ? (p[k] as unknown[]).length : 0; if (n < min || n > max) errors.push(`${at}.${k}: ${n} item(s), allowed ${min}-${max}`); };
    if (at === 'Stack') size('children', 1, 8); else if (at === 'Section') size('children', 1, 6); else if (at === 'Columns') size('children', 2, 3); else if (at === 'Form') size('children', 1, 3);
    else if (at === 'SingleChoice' || at === 'MultiChoice') size('options', 1, 6); else if (at === 'Map') size('refs', 1, 8);
    for (const [k, max] of [['text', at === 'Notice' ? 300 : 500], ['label', 80], ['title', 80], ['submitLabel', 40]] as const) if (typeof p[k] === 'string' && (p[k] as string).length > (at === 'QuickReply' && k === 'label' ? 48 : max)) errors.push(`${at}.${k}: longer than ${max} characters`);
    if (depth > LIMITS.depth) errors.push(`too_deep:${at}`);
    switch (at) {
      case 'Stack': case 'Columns': walk(p.children, depth + 1); break;
      case 'Section': addText(p.title); walk(p.children, depth + 1); break;
      case 'Text': addText(p.text); break;
      case 'Notice': addText(p.text); break;
      case 'OrderSummary': case 'WarrantyStatus': checkRef(p.ref, 'order.', ['order'], at); break;
      case 'AddressSummary': checkRef(p.ref, 'addr.', ['addr'], at); break;
      case 'ServicePointSummary': checkRef(p.ref, 'sp.', ['sp'], at); break;
      case 'QuoteComparison': checkRef(p.ref, 'cmp.', ['compare'], at); break;
      case 'QuoteMetric': { const b = checkRef(p.ref, 'quote.', ['quote'], at); if (b?.kind === 'quote' && p.metric === 'change' && !b.scope.endsWith('.alt')) errors.push(`${at}: metric "change" only exists on a what-if (.alt) quote, not on "${String(p.ref)}"`); break; }
      case 'Map': { const refs = (p.refs as unknown[]) ?? []; if (refs.length === 0) errors.push('Map: needs at least one binding'); refs.forEach((r) => { const b = ctx.bundle.bindings[String(r)]; if (!b || (b.kind !== 'sp' && b.kind !== 'addr')) errors.push(`Map: "${String(r)}" is not an address or service point binding`); }); break; }
      case 'SingleChoice': {
        inputs++; addText(p.label);
        const field = String(p.field); const refs = ((p.options as unknown[]) ?? []).map(String);
        const want: Record<string, { prefix: string; kinds: string[]; optField?: string }> = { order: { prefix: 'order.', kinds: ['order'] }, plan: { prefix: 'plan.', kinds: ['plan'] }, returnMethod: { prefix: 'method.', kinds: ['opt'], optField: 'returnMethod' }, locationPref: { prefix: 'loc.', kinds: ['opt'], optField: 'locationPref' }, servicePoint: { prefix: 'sp.', kinds: ['sp'] }, delivery: { prefix: 'addr.', kinds: ['addr'] } };
        const w = want[field];
        if (!w) { errors.push(`SingleChoice: unknown field ${field}`); break; }
        refs.forEach((r) => { const b = checkRef(r, w.prefix, w.kinds, `SingleChoice(${field})`); if (b?.kind === 'opt' && w.optField && b.field !== w.optField) errors.push(`SingleChoice(${field}): "${r}" is for ${b.field}`); if (b?.kind === 'addr' && !/^(home|company)/.test(b.id)) errors.push(`SingleChoice(delivery): "${r}" cannot be applied by a button in this version`); });
        if (seenFields.has(`select:${field}`)) errors.push(`duplicate_control:SingleChoice(${field})`); seenFields.add(`select:${field}`);
        controls.push({ kind: 'select', field: field as never, refs }); break;
      }
      case 'MultiChoice': {
        inputs++; addText(p.submitLabel);
        const refs = ((p.options as unknown[]) ?? []).map(String);
        refs.forEach((r) => checkRef(r, 'symptom.', ['opt'], 'MultiChoice(symptoms)'));
        if (seenFields.has('multi')) errors.push('duplicate_control:MultiChoice'); seenFields.add('multi');
        controls.push({ kind: 'multi', field: 'symptoms', refs }); break;
      }
      case 'QuickReply': {
        inputs++; addText(p.label);
        const kind = String(p.kind), target = String(p.target ?? ''), value = p.value === undefined ? undefined : String(p.value);
        if (kind === 'adopt') { const b = checkRef(target, 'cmp.', ['compare'], 'QuickReply(adopt)'); if (b?.kind === 'compare' && !b.applyIntent) errors.push(`QuickReply(adopt): "${target}" has nothing that can be applied`); else if (b) controls.push({ kind: 'adopt', ref: target }); }
        else if (kind === 'apply') {
          if (!(APPLY_FIELDS as readonly string[]).includes(target) || value === undefined) { errors.push(`QuickReply(apply): target must be one of ${APPLY_FIELDS.join('|')} with a value`); break; }
          const v = validateIntent({ [target]: value });
          if (!v.ok) errors.push(`QuickReply(apply): ${target}=${value} is not a legal value (${v.reason})`); else controls.push({ kind: 'apply', field: target as never, value });
        } else if (kind === 'ask') { if (!target.trim()) errors.push('QuickReply(ask): empty question'); else { addText(target); controls.push({ kind: 'ask', text: target }); } }
        break;
      }
      case 'DatePicker': {
        inputs++; addText(p.label);
        if (!['deadline', 'pickupDate'].includes(String(p.field))) errors.push(`DatePicker: bad field ${String(p.field)}`);
        else if (!insideForm) { if (seenFields.has(`date:${String(p.field)}`)) errors.push(`duplicate_control:DatePicker(${String(p.field)})`); seenFields.add(`date:${String(p.field)}`); controls.push({ kind: 'date', field: p.field as never }); }
        break;
      }
      case 'TimeSlotPicker': { inputs++; addText(p.label); if (!insideForm) { if (seenFields.has('slot')) errors.push('duplicate_control:TimeSlotPicker'); seenFields.add('slot'); controls.push({ kind: 'slot' }); } break; }
      case 'Form': {
        inputs++; addText(p.title); addText(p.submitLabel);
        const kids = ((p.children as ElementNode[]) ?? []).filter((c) => c && c.type === 'element');
        const fields = kids.map((c) => (c.typeName === 'TimeSlotPicker' ? 'pickupSlot' : String((c.props as Props).field))) as ('pickupDate' | 'pickupSlot' | 'deadline')[];
        if (new Set(fields).size !== fields.length) errors.push('Form: the same field twice');
        if (seenFields.has('form')) errors.push('duplicate_control:Form'); seenFields.add('form');
        insideForm = true; walk(kids, depth + 1); insideForm = false;
        controls.push({ kind: 'form', fields }); break;
      }
      default: errors.push(`unknown_component:${at}`);
    }
  };
  let insideForm = false;
  walk(res.root, 1);
  if (nodes > LIMITS.nodes) errors.push(`too_many_components:${nodes}`);
  if (inputs > LIMITS.inputs) errors.push(`too_many_inputs:${inputs}`);
  if (textChars > LIMITS.textChars) errors.push(`too_much_text:${textChars}`);

  // figures in wording must come from the application
  for (const t of texts) { const bad = guardAnswer(t, ctx.allowed); if (bad.length) errors.push(`figure_not_in_facts: ${bad.join(', ')} in "${t.slice(0, 80)}"`); }
  // the program must offer what the application is waiting for (for a turn that changed state)
  if (ctx.requireNeed) for (const r of requiredControls(ctx.need, ctx.state)) if (!r.has(controls)) errors.push(`missing_input: the application is waiting for ${r.id}; include ${r.label}`);
  return out();
}
