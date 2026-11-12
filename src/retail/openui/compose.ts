/**
 * Server side of the model-written interface (v0.5.0). Per natural-language turn: ONE planning call (JSON: mode, changes,
 * read-only queries) and ONE Lang call that writes the chat UI as OpenUI Lang from application facts and binding ids. The
 * application validates the program (`checkLang`); if it is rejected it gets at most ONE repair call (counted and traced like
 * any other). A clicked control (an "event") needs only the Lang call. Nothing here changes state or submits anything.
 */
import { applyIntent } from '../flow.ts';
import { PLAN_LABEL, SERVICE_POINTS } from '../data.ts';
import { nextNeed, reportOf, type Need, type TaskState } from '../state.ts';
import { appointmentProblem, isPickupDateValid } from '../rules.ts';
import { addNumbersFromText, buildAllowed, buildFacts, fallbackAnswer, memoOf, parseJson, parseTurnPlan, runQueries, turnSystemPrompt, userBlock, type ModelCall, type QueryResult, type Stage, type TurnInput, type TurnOutcome } from '../turn.ts';
import { buildBundle, bindingCatalog, type EvidenceBundle } from './bundle.ts';
import { checkLang } from './validate.ts';
import { LIBRARY_VERSION, library } from './library.tsx';
import type { Control } from './events.ts';

export interface LangPayload {
  ok: boolean; program: string | null; raw: string; errors: string[]; warnings: string[]; repaired: boolean; attempts: number;
  controls: Control[]; components: string[]; summary: string; bundle: EvidenceBundle; libraryVersion: string; need: Need | null; stateRevision: string;
}

const PLAN_UI_ADDENDUM = `\nINTERFACE MODE: the on-screen interface is composed by a separate second step. Output ONLY {"mode":...,"changes":{...},"queries":[...]}. Leave out "answer", "ui" and "quick".`;
export const planSystemPrompt = (): string => turnSystemPrompt() + PLAN_UI_ADDENDUM;

const RULES = [
  'You write the visible reply of an after-sales chat assistant as ONE openui-lang program. Output only the program: no markdown fence, no commentary.',
  'THE APPLICATION OWNS THE FACTS. Never invent or compute a price, date, number of days, distance, eligibility or delivery estimate. Show facts with components that take a binding id from BINDINGS (QuoteMetric, QuoteComparison, ServicePointSummary, AddressSummary, OrderSummary, WarrantyStatus, SingleChoice options, Map). Wording (Text/Notice/labels) may contain a figure only if it appears in FACTS, QUERY RESULTS, TURN or the user message, copied exactly (like "Nov 15", "¥10.00", "3 days", "4.5 km"). Never type your own arithmetic, such as "2 days earlier"; use the deltaDays/deltaCents given or a QuoteMetric with metric "change".',
  'Every ref/option you write must be copied from the BINDINGS list (exact text). A binding fits only the component that matches its kind.',
  'TURN.mode tells what happened. discuss: the user asked for an explanation: answer it directly in the first Text (start with the answer, then the reasons; max ~80 words), add a component only if it makes the answer clearer. what_if: nothing was changed; show the relevant QuoteComparison (cmp.* binding of the query result) with one short Text that states the main difference, then a QuickReply of kind "adopt" for that comparison if the user might want it, and say that nothing has been changed yet. change: the application has ALREADY applied the change and shown TURN.report to the user: do not repeat it, do not claim anything else changed.',
  'NEED is what the application is waiting for. For a change turn, include the SMALLEST input that answers NEED and nothing that asks for something else: one thing at a time. Match NEED: order -> SingleChoice("order", order.* options); symptoms -> MultiChoice; deadline -> DatePicker("deadline"); plan -> a short comparison of the plans (QuoteMetric of quote.now.*) plus SingleChoice("plan", plan.* options); method -> SingleChoice("returnMethod", [method.courier, method.store]); location -> SingleChoice("locationPref", loc.* options); servicepoint -> Map of the candidate service points plus SingleChoice("servicePoint", sp.* options) (only service points that handle the chosen plan); dropdate / pickup -> only what NEEDDETAIL says is missing: a DatePicker("pickupDate") if the date is missing, a TimeSlotPicker if the time window is missing, both inside one Form when both are missing; when NEED is "confirm" or none, add no input (the application shows its own confirmation card; say the summary is next and that nothing is submitted until the user presses Confirm and submit).',
  'On discuss and what_if turns do NOT include the input for NEED: the user asked something else, and the earlier question (if any) is still open above. Include an input only if the question itself is about choosing it (for example comparing service points may end with the choice of service point). Never add a plan, return-method or date input to an explanation.',
  'For discuss and what_if turns you may offer QuickReply buttons (max 3) for natural next steps; they do nothing until pressed. Never offer to submit: submission is only the application\'s Confirm button.',
  'Always write in English, even when the user writes in another language (the product UI is English only); keep the user\'s meaning. To offer a what-if you showed, use QuickReply kind "adopt" (never write a date or an amount yourself). Use kind "apply" only for simple choices such as plan, return method or delivery target.',
  'Be brief: at most 6 top-level components, normally 2-4. Plain English. Do not ask the user a question in Text that a control you included already asks. Do not mention bindings, ids, JSON or openui.',
  'Shape example (placeholders only, copy real ids from BINDINGS): root = Stack([a, b])\na = Text("<answer in words>")\nb = SingleChoice("servicePoint", ["sp.<id>", "sp.<id>"], "<label>")',
];
export const langSystemPrompt = (): string => library.prompt({ toolCalls: false, bindings: false, builtinFunctions: false, examples: [], preamble: 'You are the interface composer of an after-sales assistant. You answer ONLY in openui-lang.', additionalRules: RULES });

/** Exactly what is missing for the pending question, in words, so the model asks for no more and no less. */
export function needDetail(t: TaskState, need: Need | null): string {
  if (!need) return 'nothing to ask';
  if (need === 'confirm') return 'everything is known; the summary is next';
  const k = t.pickup; const sp = SERVICE_POINTS.find((s) => s.id === k.servicePointId);
  if (need === 'dropdate' || need === 'pickup') {
    const parts: string[] = [];
    if (!isPickupDateValid(k.date)) parts.push(`the ${need === 'pickup' ? 'pickup' : 'drop-off'} date is missing`); else parts.push(`the date is already ${k.date}`);
    const slotMissing = need === 'pickup' ? !k.slot : !!sp?.appointment && (!k.slot || !!appointmentProblem(sp.id, k.date, k.slot));
    if (slotMissing) parts.push(sp?.appointment ? `${sp.name} needs an appointment (open ${sp.hours}), so a time window is missing` : 'the courier time window is missing'); else if (k.slot) parts.push(`the time window is already ${k.slot}`);
    return parts.join('; ');
  }
  if (need === 'servicepoint') return `the user must pick a service point${t.planId ? ` that handles ${PLAN_LABEL[t.planId]}` : ''}`;
  return need;
}

function langUser(input: TurnInput, factsText: string, catalog: string, mode: string, report: string | null, notes: string, need: Need | null, detail: string, results: QueryResult[]): string {
  const base = userBlock(input, factsText, results.length ? results : undefined).replace(/\nUSER MESSAGE: [\s\S]*$/, '');
  return `${base}\nTURN: ${JSON.stringify({ mode, report: report ?? 'nothing changed', applicationNotes: notes || null })}\nNEED: ${need ?? 'none'}\nNEEDDETAIL: ${detail}\n\nBINDINGS (use these ids only):\n${catalog}\n\nUSER MESSAGE: ${input.message}`;
}

interface ComposeIn { input: TurnInput; mode: string; report: string | null; notes: string; results: QueryResult[]; requireNeed: boolean }
/** Lang call + validation + at most one repair. Returns the payload (ok or not) or a transport failure. */
async function composeLang(a: ComposeIn, call: ModelCall, stages: Stage[]): Promise<{ lang: LangPayload } | { failure: string }> {
  const { input } = a; const t = input.task;
  const facts = buildFacts(t); const need = nextNeed(t); const detail = needDetail(t, need);
  const bundle = buildBundle(t, a.results, 'task');
  const allowed = buildAllowed(input, facts.text, a.results); addNumbersFromText(a.notes + ' ' + (a.report ?? ''), allowed);
  const user = langUser(input, facts.text, bindingCatalog(bundle, t), a.mode, a.report, a.notes, need, detail, a.results);
  const run = async (stage: 'lang' | 'repair', u: string) => { stages.push(stage); const raw = await call(stage, langSystemPrompt(), u); return { raw, check: checkLang(raw, { bundle, state: t, need, requireNeed: a.requireNeed, allowed }) }; };
  let r1: Awaited<ReturnType<typeof run>>;
  try { r1 = await run('lang', user); } catch (e) { return { failure: `model_error(lang): ${(e as Error).message}` }; }
  let last = r1, repaired = false, attempts = 1;
  if (!r1.check.ok) {
    try { last = await run('repair', `${user}\n\nYOUR PREVIOUS PROGRAM WAS REJECTED:\n${r1.check.program.slice(0, 3000)}\nREJECTED BECAUSE:\n${r1.check.errors.slice(0, 8).map((e) => `- ${e}`).join('\n')}\nReturn the corrected, complete program.`); attempts = 2; repaired = last.check.ok; }
    catch (e) { return { failure: `model_error(repair): ${(e as Error).message}` }; }
  }
  const c = last.check;
  return { lang: { ok: c.ok, program: c.ok ? c.program : null, raw: last.raw, errors: c.ok ? [] : [...r1.check.errors.map((x) => `attempt1: ${x}`), ...(attempts === 2 ? c.errors.map((x) => `attempt2: ${x}`) : [])], warnings: c.warnings, repaired, attempts,
    controls: c.ok ? c.controls : [], components: c.components, summary: c.ok ? c.texts.join(' ').slice(0, 800) : '', bundle, libraryVersion: LIBRARY_VERSION, need, stateRevision: bundle.stateRevision } };
}

/** The model-written-interface turn for a typed message. */
export async function runUiTurn(input: TurnInput, call: ModelCall): Promise<TurnOutcome> {
  const stages: Stage[] = ['plan'];
  const facts = buildFacts(input.task);
  let raw1: string;
  try { raw1 = await call('plan', planSystemPrompt(), userBlock(input, facts.text)); } catch (e) { return { kind: 'failed', reason: `model_error: ${(e as Error).message}`, stages }; }
  const j1 = parseJson(raw1);
  if (j1 === undefined) return { kind: 'failed', reason: 'model_output_not_json', stages };
  const p1 = parseTurnPlan(j1, input.task);
  if (!p1.ok) return { kind: 'failed', reason: `invalid_turn_plan:${p1.reason}`, stages };
  const plan = p1.plan;
  const results = runQueries(plan.queries, input.task);
  // a change is applied here exactly as the browser will apply it (same pure function), so the model sees the state the user will see
  let task = input.task, notes = '', report: string | null = null;
  if (plan.mode === 'change') { const r = applyIntent(input.task, plan.changes, { noAsk: true }); task = r.task; notes = r.replies.map((x) => x.text).filter(Boolean).join(' '); report = reportOf(input.task, task); }
  const composed = await composeLang({ input: { ...input, task }, mode: plan.mode, report, notes, results, requireNeed: plan.mode === 'change' }, call, stages);
  if ('failure' in composed) return { kind: 'failed', reason: composed.failure, stages };
  const lang = composed.lang;
  const answer = lang.ok ? '' : fallbackAnswer(task, results);
  return { kind: 'turn', plan: { mode: plan.mode, changes: plan.changes, answer, ui: [], quick: [] }, results, memo: memoOf(results), guard: { ok: true, violations: [], replaced: false }, ignoredChanges: plan.ignoredChanges, droppedQuick: 0, stages, lang, report, notes };
}

/** A control the user pressed was already applied by the application; the model only composes what comes next. */
export async function runUiEvent(input: TurnInput & { report: string | null; notes: string }, call: ModelCall): Promise<TurnOutcome> {
  const stages: Stage[] = [];
  const composed = await composeLang({ input, mode: 'change', report: input.report, notes: input.notes, results: [], requireNeed: true }, call, stages);
  if ('failure' in composed) return { kind: 'failed', reason: composed.failure, stages };
  return { kind: 'turn', plan: { mode: 'change', changes: {}, answer: composed.lang.ok ? '' : fallbackAnswer(input.task, []), ui: [], quick: [] }, results: [], memo: '', guard: { ok: true, violations: [], replaced: false }, ignoredChanges: false, droppedQuick: 0, stages, lang: composed.lang, report: input.report, notes: input.notes };
}
