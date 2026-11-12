# Tasks and acceptance

> Paths under `evidence/` refer to local working evidence kept by the maintainers. That directory is git-ignored and is not part of this repository.

**Current: v0.3.0 (adds Retail mode).** v0.2.0 (chat-centric reporting) is unchanged and still the Reporting mode. v0.1.0 (side dashboard) is superseded and is not part of this repository. Phases 1-4 below are the v0.1.0 history. Status: ✅ verified · 🔶 partly · ⬜ not started.

## v0.3.0 — Retail mode: conversational after-sales (the UI is English)
Additive. v0.3.1 reworked the Retail interaction model (rows 6.13-6.19). Reporting is not modified; a mode switch (Reporting / Retail) wraps both. Loop as before: implement → `SCENE_PORT=<free> npm run verify:offline` → fix → evidence in `evidence/v0.3.0/`.

| # | Acceptance (requirement section 8) | Check |
|---|---|---|
| 6.1 ✅ | Mode switch; Reporting stays default and keeps its conversation, Retail keeps its own; existing tests untouched | `e2e/retail.spec.ts` R1, existing suites |
| 6.2 ✅ | Whole flow in the chat stream (item → plans → address → return → summary → receipt), no side report | R2 |
| 6.3 ✅ | Six component kinds really operate: Map (pins, pick a point, choose service point), Single-choice, Multi-choice, Quick reply, Form, Date picker; each changes later quotes or the submitted content | R2, R3, R9, R10 |
| 6.4 ✅ | A concrete latest-receive date is required; "next week" alone is not guessed; dates are validated against today and the departure date | `tests/retail-intent.test.ts`, `retail-flow.test.ts`, R2 |
| 6.5 ✅ | Three plans each show eligibility (with reason), fees, timeline and a timing label (on time / late / unknown / no usable device) | `tests/retail-rules.test.ts` (hand-computed), R2, R8 |
| 6.6 ✅ | Recommendation cites dates; none made when nothing meets the date; refund never counts as solving the need | rules tests, R7 |
| 6.7 ✅ | "Ship it to my company" updates the delivery address, recalculates cost and ETA, calls out a late result; refund asks what it means; none/one/many company addresses handled | flow tests, R2, R8, R9, R10 |
| 6.8 ✅ | Pickup (courier/store, date, slot, service point map) and delivery are saved separately | flow tests, R2 |
| 6.9 ✅ | Old plan cards become "Updated" and cannot act; changing the slot makes the confirm card stale; after submit all cards are locked and changes go to a change flow | `cardLive` tests, R2, R10 |
| 6.10 ✅ | Nothing is created without the explicit confirm; double click and replay create one case; failure shows "Request not created", keeps inputs, retry is safe; receipt equals the confirm card | `tests/retail-service.test.ts`, R2, R3, R9 |
| 6.11 ✅ | Model never supplies numbers: intent whitelist, failures fall back to a labelled rules parser | `tests/retail-intent.test.ts` |
| 6.12 ✅ | Reporting unchanged: all v0.2.0 unit + browser tests green | `npm run verify:offline` |

| 6.13 ✅ | **v0.3.1 interaction model.** Conversation advances by what is still missing (`nextNeed`), one question per turn; no step-by-step form, no card that collects several fields | `tests/retail-dialog.test.ts`, R2, R3 |
| 6.14 ✅ | Natural language, buttons and components edit the same task: "the first one, the left side has no sound" sets item AND symptom; "Exchange, ship it to my company" sets plan AND delivery address; nothing already given is asked again | dialog tests, R2 |
| 6.15 ✅ | Mid-conversation "I would like to drop-off, give me the address" is understood (return method + address request): asks ONE question when the place is unknown (company or home), otherwise lists service points with address, hours and appointment info on a map; a refund / plans without drop-off fall back with an explanation | dialog tests, R2, R5 |
| 6.16 ✅ | Components appear only when needed: single-choice (order, plan, service point), multi-choice (symptoms, only if not said), date picker, map, address form only when no company address exists, quick replies | R2, R3, R9, R10 |
| 6.17 ✅ | Answered cards collapse into a one-line summary with "Change"; changing one answer keeps the rest; outdated plan lists / summaries are marked "Updated" and cannot submit; the full summary appears only when everything is known | R2, R4, R6, R15 |
| 6.18 ✅ | Not understood: contextual question (e.g. "drop the old item off yourself, or have a courier collect it?"), never "use the cards below"; an open question card is not duplicated | dialog tests, R7 |
| 6.19 ✅ | **Both interpreters verified separately** (rules path now only by explicit choice, see 6.22). Real model: 10 phrases (`scripts/verify-retail-live.ts`, 10/10) and a real-model browser run (`e2e-live/retail.spec.ts`, every typed message "Understood by model"). Fallback: the same 10 phrases through the rules parser (10/10) and the whole offline browser suite | `evidence/v0.3.0/live/`, `evidence/v0.3.0/REPORT.md` |

| 6.20 ✅ | **v0.3.2 traceable NL.** Every typed message gets a request id that is visible in the UI, echoed by the server and stored in its trace; the record says whether a model request was really sent, which interpreter produced the result, HTTP status, failure reason and timings (first byte / full response / server / round trip); no key, prompt or message text | `tests/retail-trace.test.ts`, R17-R21, `e2e-live/retail.spec.ts` (+ `evidence/v0.3.0/trace/live-run-trace.json`) |
| 6.21 ✅ | Typed messages go to the model by default with the task state; buttons and pickers are direct actions (no interpret request) | R18, R21 |
| 6.22 ✅ | No silent substitution: a model failure says so, changes nothing and offers Retry or an explicit "use basic rules"; "Rules only" is a visible user choice; "Understood by model" appears only with server proof of a real call (a server answer claiming success without one is rejected) | tests/retail-trace.test.ts, R17, R19 |

| 6.23 ✅ | **v0.4.0 Intelligent turn.** A question gets a direct answer built from application facts (cost, dates, eligibility, deadline margin), never "ask away"; the model may call read-only business tools (`quote_plans`, `service_points`, `policy_terms`); figures in its wording must exist in the facts/tool results or the wording is replaced by a facts-only answer | `tests/retail-turn.test.ts`, live cases 1-5, 9-13 |
| 6.24 ✅ | **Discuss / what-if / change are distinct.** Discussion and what-if never change state (model-sent changes are discarded and flagged); only `change` goes through the deterministic path; submit is impossible from a message; every state change is followed by "Changed: … / Unchanged: …" | unit + R22, R23, live 6, 14, browser live run |
| 6.25 ✅ | **Hypothetical then explicit adoption.** "If it went home, how much sooner? don't change it" shows a comparison marked "nothing was changed"; "use the home address we just compared, keep the rest" applies only that (the app's memo of the comparison is in the model's history) | R22, R23, live 2, 6, 10, 14 |
| 6.26 ✅ | **Components chosen by the agent inside a registry** (compare, plans, servicepoints, address, deadline, orders, symptoms, dropdate, pickup, terms; max 3, validated; evidence cards added by the app for every evaluated query); suggested buttons that are invalid are dropped and counted | parseTurnPlan tests, R22-R24 |
| 6.27 ✅ | Relative what-ifs are computed by the app (`deadlineShiftDays`), not by model date arithmetic ("trip two days earlier" → Nov 14 → margins -2 / -6) | unit, live 4, 12 |
| 6.28 ✅ | Appointment-only service points cannot be submitted without a booked slot; drop-off receipts say "you drop off the old unit", not "picked up" | unit, R24 |
| 6.29 ✅ | Different wordings of the six acceptance questions pass the same structural checks with the real model (8 cases + 6 re-worded variants) | `scripts/verify-retail-turns-live.ts`, `evidence/v0.4.0/live/` |

Gaps (stated, not hidden): the guard checks figures (money, dates, "N days", km), not meaning: a real answer once called the refund "late" although the plan table says it gives no working device; real-model coverage is 14 sentences and one 7-turn browser flow, not a sample of users; no user-utility validation was done; retail cards are React components, NOT rendered through OpenUI, and OpenPencil templates were not made; the map is a schematic SVG; which asking card is shown next is still decided by the app (`nextNeed`), the model chooses answers, evidence and extra components; the case store is in-memory; the pickup address cannot be edited in the chat; narrow-screen layout not checked.

---
## v0.2.0 — Reporting lives in the chat
Rule: every Agent reply carries its own analysis (text + OpenUI report). Report state (spec, filters, layout, open call, editing) is owned by that message; nothing global is replaced by a later question. Same loop as before: implement → `npm run verify:offline` → fix → evidence in `evidence/v0.2.0/`.

| # | Acceptance | Check |
|---|---|---|
| 5.1 ✅ | Wide chat stream, composer fixed at the bottom; no side report area | `e2e/chat.spec.ts` |
| 5.2 ✅ | Agent message = app-computed text + metric cards + chart + table (+ controls) | `tests/narrative.test.ts`, e2e |
| 5.3 ✅ | Three turns (overview → biggest answer-rate drop → drill) stay readable in the stream, each with its own range / campaigns / metric basis | e2e, `tests/chat-state.test.ts` |
| 5.4 ✅ | Follow-ups and drill-downs append; history reports are never mutated (immutability + e2e figures unchanged) | `tests/chat-state.test.ts`, e2e |
| 5.5 ✅ | Drill action is logged as an action message, then a new reply with the call list; inherits the source report's frozen range/campaign | e2e |
| 5.6 ✅ | Sort / outcome filter / paging / per-report filters / call detail update only their own message, no new message | e2e |
| 5.7 ✅ | Layout edit opened from a report message (modal); applies to that report only; separate explicit "save as preference" for future reports; pins no longer force components into later replies | e2e, `tests/layout-logic.test.ts` |
| 5.8 ✅ | Model failure / unknown metric / ambiguous campaign appear as messages; earlier reports unchanged; live vs fallback vs direct-action labels per message | e2e |
| 5.9 ✅ | Metric calculation, validation, planner, budget logic reused unchanged | existing unit tests green |

---
## v0.1.0 history
Each phase is a loop: implement → run → check → fix. A phase is done only when its checks pass AND evidence is saved. Status: ✅ verified · 🔶 partly · ⬜ not started.

## Phase 1 — foundation and minimal chain (offline)  ✅
| # | Acceptance | Check |
|---|---|---|
| 1.1 | Docs: tasks, decisions, metric definitions, component mapping | this folder |
| 1.2 | Synthetic data covers improve/decline/flat/no-previous/no-records/zero-answered/small-sample; phones fictional | `tests/metrics.test.ts` |
| 1.3 | Overview, change ranking, daily trend, drill-down equal hand-computed `tests/expected.json` | same |
| 1.4 | Zero denominator → null ("—"); no previous data → null ("Cannot compare"), never 0 | same |
| 1.5 | Model JSON validation rejects unknown metric/campaign/component/range/extra fields | `tests/validate.test.ts` |
| 1.6 | OpenPencil edits (order, width, accent, pin) read back into `Layout`; unsupported edits rejected | `tests/layout-mapping.test.ts` (real CLI) |
| 1.7 | OpenUI renders library components; prompt lists only allowed ones | `spikes/openui.test.tsx` |
| 1.8 | Paid calls fail closed without key or budget | `tests/budget.test.ts`, `npm run verify:live` |
| 1.9 | One command runs everything offline | `npm run verify:offline` |
Not in phase 1: any live DeepSeek call (needs key + human-set budget), browser UI.

## Phase 2 — app shell and live chain  ✅ (with listed gaps)
| # | Acceptance | Check |
|---|---|---|
| 2.1 | Vite app: demo-data badge, date range, campaign filters, chat, OpenUI-rendered report, metric definitions | `e2e/phase2.spec.ts` |
| 2.2 | DeepSeek → validate → engine → OpenUI; browser never sees the key; app guards unknown components | `tests/planner.test.ts`, `tests/library.test.tsx`, `npm run verify:live`, `npm run test:e2e:live` |
| 2.3 | Source badge live vs prepared fallback; prepared analyses never labelled live | e2e: fallback badge kept after model failure |
| 2.4 | Model failure/invalid keeps current report, offers retry + prepared | e2e (stub-fail) |
| 2.5 | Loading marks report busy; empty result keeps filters; Cannot compare / "—" | e2e |
| 2.6 | Overview and change figures in the browser equal `tests/expected.json` | e2e offline + e2e live |
Gaps carried to phase 3: Edit layout is a disabled button; call list has no filter/sort/paging/detail panel; no pinning; follow-up "add component" is verified with a mocked plan response, not yet with a real model answer.

## Phase 3 — drill-down, states, layout editing  ✅ (with listed gaps)
| # | Acceptance | Check |
|---|---|---|
| 3.1 | Drill-down: outcome filter, time sort, paging (10/page), detail panel, clear filters, back to overview; every row matches campaign + range + outcome | `e2e/phase3.spec.ts` (drill-down), `tests/metrics.test.ts` |
| 3.2 | Ambiguous campaign → selection list; unknown metric → list; both leave report unchanged (also with the live model) | `e2e/phase2.spec.ts` (mocked), `e2e-live` (live) |
| 3.3 | Separate edit view (`#/edit-layout`) with Apply/Cancel; Apply goes through OpenPencil file + supported-change check; layout restored after refresh | e2e layout editing |
| 3.4 | Pinned components survive follow-ups and filter changes (data still follows filters); pin conflict keeps the pin and offers Unpin | e2e + `tests/layout-logic.test.ts`; live follow-up in `e2e-live` |
| 3.5 | Unsupported design edit (off-palette colour) rejected, draft and live layout unchanged; unmappable layout reported, previous layout kept | e2e (real OpenPencil file edited with the CLI) |
Gaps: the edit view is a form that round-trips through an OpenPencil `.fig` file; it is NOT the OpenPencil GUI embedded, and the GUI itself was not exercised (edits to the file were made with the CLI). Call-list page size 10 is an assumption. Narrow-screen layout not checked.

## Phase 4 — end-to-end demo and evidence  ✅ (with listed gaps)
| # | Acceptance | Check |
|---|---|---|
| 4.1 | Demo flow runs end to end with the real model, no workarounds | `e2e-live/demo.spec.ts`, video in `evidence/phase4/` |
| 4.2 | Same flow works without a model (prepared analyses) | `e2e/demo-offline.spec.ts` |
| 4.3 | Every drill-down list matches its filters across all combinations | `tests/drilldown-property.test.ts` |
| 4.4 | Model vs application contribution visible | provenance panel |
| 4.5 | Acceptance matrix and README | `evidence/phase4/ACCEPTANCE.md`, `README.md` |
Gaps: human-paced run against the 2-minute target; daily chart values not browser-checked; OpenPencil GUI; repeated live runs. See ACCEPTANCE.md.

v0.2.0 gaps: live-model chat flow (`npm run test:e2e:live`, rewritten) has NOT been run (needs a key and a human-set budget); responsive narrow-screen layout not checked; OpenPencil GUI still not embedded (form + `.fig` round trip, now in a modal).


## v0.5.0 — Retail: model-written OpenUI interface (additive; Reporting untouched)  ✅ vertical slice, listed gaps
Source: `docs/requirement/scene-v0.5-openui-proposal-20261111.md` (A business contract → B minimal vertical slice → C widen). Evidence: `evidence/v0.5.0-20261111/REPORT.md`.
| # | Acceptance | Check |
|---|---|---|
| 7.1 (A) | A stated time window is understood (`pickupSlot` in Intent, parser, model contract) and a date + window in one sentence complete the booking without another click | `tests/retail-contract.test.ts`, `e2e/retail-openui.spec.ts` V5, live cases 8-9 |
| 7.2 (A) | Appointment slots lie inside opening hours (sp-2 opens 10:00: 09:00-12:00 never offered nor accepted); a booked slot never survives a change that puts it outside hours | `tests/retail-contract.test.ts`, V1 |
| 7.3 (A) | Arrival equal to the deadline reads "on your deadline day", never "before" (recommendation, comparison, fallback wording, plans card) | `tests/retail-contract.test.ts`, `tests/retail-openui.test.tsx` |
| 7.4 (A) | State revision (`revisionOf`) and per-message frozen bundle: old messages keep their facts, controls switch off when the revision changes | `tests/retail-openui.test.tsx`, V1 |
| 7.5 (B) | The MODEL writes OpenUI Lang (separate free-text channel, `deepseekLang`, reserve + per-call trace); the app does not convert card ids to Lang | `src/retail/openui/compose.ts`, `src/ai/planner.ts`, live runs |
| 7.6 (B) | Lang is validated before rendering: library membership, props, array/length limits, binding ids AND kinds, legal actions, figures in wording (guard), unreferenced/unresolved statements, structure limits, and "offers what the app is waiting for" | `tests/retail-openui.test.tsx` (34), V2 |
| 7.7 (B) | Facts come from bindings (EvidenceBundle), not model text; what-if never writes state; adoption (`QuickReply adopt`) derives the change from the tool, not from model words | unit + V1 + live cases 2-5, 7 |
| 7.8 (B) | Components emit semantic events; the app checks the message is current, the control was offered, the value is legal, then applies the SAME `Intent` through `applyIntent` as typed language | `eventToIntent` tests, V1 |
| 7.9 (B) | Failure policy: invalid program -> at most ONE counted repair -> still invalid: explicit message, raw program and reasons inspectable, standard card shown, no state change; model/network failure: shown, nothing invented | V2, V3, V4 |
| 7.10 (B) | Vertical slice explain -> home what-if -> adopt -> store appointment -> submit receipt, offline (mock model, real app) and with the real model in the real browser | V1; `e2e-live/retail-openui.spec.ts` |
| 7.11 (C) | Composed components cover item, problem, deadline, plans, address + map, store appointment (`Stack Section Columns Text Notice OrderSummary WarrantyStatus QuoteMetric QuoteComparison AddressSummary ServicePointSummary Map SingleChoice MultiChoice QuickReply Form DatePicker TimeSlotPicker`) | library + validator tests; live: Form, DatePicker, TimeSlotPicker, Map, SingleChoice used by the real model |
| 7.12 | Frozen live protocol (12 wordings not used in prompts, 2 Chinese), render / facts / interaction / task recorded separately | `scripts/verify-retail-ui-live.ts`, `evidence/v0.5.0-20261111/live-cases.md` |
Gaps: streaming preview not built (programs are validated whole before anything renders, so nothing unvalidated can be pressed); delivery to a custom/second company address cannot be chosen with a button; no free address-editing Form; messages and drafts are not persisted across a reload; Reporting still uses `programFor` (not model Lang); OpenPencil is not used for Retail; live sample is small (12 wordings, 1 flow); no user-utility validation; the model tends to add components (one case had 6) and once still asked the pending question inside an answer.
