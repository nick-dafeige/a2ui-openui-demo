# Scene architecture (Reporting v0.2.0 and Retail v0.3.0 to v0.5.0)

> How the two modes work, why they are built this way, and how to extend them. One document for both.
> Sequence diagrams: [SEQUENCE-REPORTING.md](SEQUENCE-REPORTING.md), [SEQUENCE-RETAIL.md](SEQUENCE-RETAIL.md). Decisions and metric definitions: `DECISIONS.md`. Acceptance: `TASKS.md`. Rules for agents: `../AGENTS.md`.
> All data is synthetic. The reference date is fixed at 2026-11-10 (UTC); "last week" is 2026-11-02 to 2026-11-08. The retail submit service is simulated: no real refund, shipment or booking.
> Retail was written 2026-11-12 from the code and one real run (evidence is kept locally under `evidence/`, which is not committed). In Retail, `intent.ts`, `rules.ts`, `service.ts`, `trace.ts` and `cards.tsx` were read only at the header level, so their descriptions are shorter. Reporting is rebuilt from the code and from the earlier Reporting architecture note.

## 1. Overview

Scene is one React app with a mode switch (`src/Shell.tsx`, hash `#/` for Reporting and `#/retail` for Retail). Both modes keep their conversation mounted once opened, so switching never loses it.

- **Reporting**: the user asks about call campaigns in plain language. A model turns the question into a small JSON request from a closed vocabulary. The application validates it, computes every figure itself and shows a report inside the reply. The model never writes numbers, text or UI.
- **Retail**: the user chats about an after-sales request. A model plans the turn from application facts, and in the default mode a second model call writes the screen as OpenUI Lang from components and fact bindings the application offers. The application validates it, owns all state and is the only thing that can submit.

Shared pieces: `@openuidev/react-lang` renders the components, DeepSeek is called only from the local Vite server (the browser never sees the key), every paid request is reserved in a ledger first, and all data is synthetic.

## 2. Principles that hold in both modes

1. **The model does not produce facts.** Figures, dates, eligibility and quotes come from application code (`src/query/metrics.ts` in Reporting, `src/retail/rules.ts` in Retail).
2. **Model output is untrusted input.** It is validated against a whitelist before use. OpenUI silently drops components outside its library and unresolved references without raising an error, so the application checks for them itself before rendering.
3. **State belongs to the application and history is not rewritten.** Reporting: a report belongs to its message. Retail: one `TaskState`, and messages are frozen snapshots whose controls switch off when the state moves on.
4. **No silent fallback.** Replies are labelled by source (live model, prepared analysis, direct action, rules). A model failure is shown as a failure and never presented as a success.
5. **Browser-reachable code must not import `node:*`.** `tests/browser-safe.test.ts` guards this (an import once caused a blank screen).

| | Reporting | Retail (model-written) |
|---|---|---|
| Model calls per question | 1 | 2 for a typed turn, 1 for a control press, 1 more for a repair |
| Model output | JSON request | JSON plan, then OpenUI Lang |
| Who writes the OpenUI program | The application (`programFor`) | The model, checked by `checkLang` |
| Who writes the visible text | The application (`narrative`) | The model, with figures restricted to the facts |
| State | One `ReportInstance` per message | One shared `TaskState` |

## 3. Reporting (v0.2.0)

### 3.1 One sentence

The user asks in chat. The model only translates the question into a whitelisted JSON request. The application validates it, computes every figure with its own code, and renders predefined components, as OpenUI, inside that reply. A report always belongs to its reply and is never shown anywhere else.

### 3.2 Flow

The step-by-step diagrams are in [SEQUENCE-REPORTING.md](SEQUENCE-REPORTING.md). In short:

```
User question
  → POST /api/plan {question, selectedCampaignId}   (the browser never gets the API key)
  → plannerApi (vite.config.ts): reserve budget, one DeepSeek call (forced JSON), normalize, validateRequest
  → PlanOutcome: plan | unknown_metric | need_campaign | failed
  → browser App.tsx: reportFromRequest(request, source, previous report, layout preference) → ReportInstance (new)
  → ReportMessage.tsx: buildReport (every figure), narrative (text), programFor(arrange(layout, components)) → <Renderer/>
```

- **Three sources of a reply**: `live` (model), `fallback` (prepared analysis buttons, no model) and `action` (a click such as a drill-down, no model). Every reply shows its source badge; a prepared or action result never passes as live.
- **Failures** become an agent message (model error, unknown metric, ambiguous campaign). Earlier reports are untouched. The error message offers Retry and the prepared analyses.

### 3.3 What the model may say (the request schema)

```jsonc
{
  "intent": "campaign_overview | change_analysis | unanswered_drilldown",
  "metrics": ["calls","answered","answer_rate","conversions","conversion_rate","answer_rate_change","unanswered_calls"],
  "campaignIds": ["c1".."c7"],     // omitted = all campaigns
  "range": {"start":"YYYY-MM-DD","end":"YYYY-MM-DD"},   // omitted = inherit the previous report's range
  "components": ["calls_card","answer_rate_card","conversion_card","daily_trend","daily_call_volume","campaign_table","change_ranking","call_list"],
  "sortBy": "answer_rate", "order": "desc|asc", "limit": 1-7,   // only for campaign_overview rankings
  "only": true                                                    // with metrics/components = exactly these
}
```

`validateRequest` (`src/query/validate.ts`) checks every field and rejects unknown keys (`unexpected_field`), which is how "the model never supplies figures" is enforced. `normalize` first drops harmless redundancy, for example a `sortBy` on `change_analysis`, instead of failing the whole question.

### 3.4 Which components appear (`specFor`)

- **Default per intent**: overview = three cards + trend + campaign table; change = answer-rate card + ranking + trend; drill-down = call list.
- `components` without `only` are appended to the defaults.
- Named `metrics` keep only the matching cards, followed by the default trend and table; with `only`, just the cards remain.
- A ranking (`sortBy`) shows only the ranked campaign table, and its columns are only the metrics that were asked for (`spec.columns`).
- **Free composition**: `only: true` plus `components` (and/or metric cards) gives exactly those components for any intent. The report is marked `custom` and titled "Custom report".
- `call_list` needs **exactly one** campaign, otherwise the outcome is `need_campaign` and the UI offers campaign buttons.

### 3.5 Report state

```ts
ReportInstance {
  id, title, source: 'live'|'fallback'|'action', request?,
  spec:         { intent, components, drill?{campaignId,outcome,sort,page}, rank?, columns?, custom? },
  filters:      { range, campaignIds },   // current; the user may change them inside this message
  askedFilters: { range, campaignIds },   // as asked; kept for comparison and reset
  layout,                                  // this report's own layout (copied from the preference at creation)
  openCallId, editing
}
Msg = user | action (a recorded click) | agent { text, report?, choose?, error? }
```

- **Append, never overwrite.** A new question, follow-up or drill-down adds a message. `patchReport` replaces only the target message and returns every other message as the same object (a unit test asserts it).
- **Scope inheritance.** The date range is inherited from the latest report. The campaign scope is not: a new question covers all campaigns unless it names some. The exception is a follow-up that only adds components (same intent, no `only`, no ranking), which counts as changing the previous report and keeps its scope. A drill-down copies its source report's range.
- **Local actions do not add messages.** Sorting, paging, outcome filter, date and campaign filters, and opening a call only change that report's state. A scope that differs from the question shows "filters changed after the question", and "Reset to original scope" restores it.
- **Drill-down**: clicking "View unanswered calls" first appends an `action` message that records the click, then a new reply with the call list (source `action`).

### 3.6 Metric definitions and sample size

Authoritative definitions are in `DECISIONS.md`; the report shows them on every reply (`basis()`).

- Calls = records in range. Answered = outcome `connected`. **Answer rate = answered ÷ calls. Conversion rate = conversions ÷ answered** (the denominator is answered calls, not all calls).
- Change = current answer rate − previous answer rate, in **percentage points**. The previous period is the adjacent period of equal length. Unanswered = no answer, busy or failed.
- A zero denominator is `null` and shows `—`; a missing previous period is `null` and shows "Cannot compare". It never shows 0.
- **Small samples**: `MIN_SAMPLE = 30` (an assumption pending business confirmation). The "dropped the most" conclusion and the main drill-down button use only campaigns with at least 30 calls in both periods. A bigger drop on a small sample (for example Tiny Sample Test, -50 pp on 10 calls) stays in the table with a `low sample` badge, and the text says why it is not the conclusion. With the demo data the conclusion is Payment Reminder (60% to 40%, -20 pp).

### 3.7 Layout and OpenPencil

- A `Layout` has one item per component: `{id, width: half|full, accent, pinned}`. Array order is display order. Accent colours come from a fixed palette (brand, green, red, amber, purple).
- **Each report has its own layout** (a copy of the preference at creation). "Apply to this report" changes that report only. "Apply and save as preference" or "Save layout as preference" writes the preference (localStorage `scene.layout.v1`), which affects later reports only.
- **Pinned** means first within a report that contains the component. A pin never forces a component into a reply that does not need it (`src/layout/arrange.ts`).
- **OpenPencil round trip** (`src/layout/mapping.ts`, Node side): `Layout → HTML → .fig` (`openpencil import`), the user edits in OpenPencil, `openpencil eval` reads it back, and `mapNodesToLayout` accepts only supported edits (order, half or full width, palette colour, pinned = locked). Anything else is rejected and the previous layout stays. A node's identity is its **name** `scene-<id>`, because node ids are reassigned when the file is saved.
- Layout never carries query conditions. Style and query are kept separate.
- Limit: the editor is a form plus a `.fig` export and import round trip. The OpenPencil GUI is not embedded.

### 3.8 Module map

| Path | Role |
|---|---|
| `src/data/spec.ts` | Hand-written data spec (each campaign's calls, answered and so on, for the previous and current period): the independent "answer key". |
| `src/data/generate.ts` | Generates call records from the spec (all phone numbers are fictional). |
| `src/query/metrics.ts` | The only calculation engine: totals, per campaign, change, daily trend, drill-down (filter, sort, page). |
| `src/query/validate.ts` | Whitelist for model output: `INTENTS`, `METRICS`, `SORTABLE`, `COMPONENTS`. |
| `src/ai/planner.ts` | System prompt, `planQuestion`, `normalize`, the DeepSeek client (Node side). |
| `src/ai/budget.ts` | The paid-request ledger. |
| `src/ai/prepared.ts` | Prepared analyses (browser-safe, no Node modules). |
| `src/report/model.ts` | `ReportSpec`, `Filters`, `specFor`, `rankRows`, `buildReport`, `MIN_SAMPLE`. |
| `src/report/library.tsx` | OpenUI components (`MetricCard`, `DailyTrend`, `CampaignTable`, `ChangeRanking`, `CallList`, `Report`), `programFor`, `unknownComponents`. |
| `src/report/format.ts` | Shared formatting: `—` for a zero denominator, "Cannot compare". |
| `src/chat/state.ts` | Pure message and report state: `reportFromRequest`, `drillReport`, `patchReport`, `latestReport`. |
| `src/chat/narrative.ts` | The summary text and the metric basis (`narrative`, `basis`, `headline`). |
| `src/chat/ReportMessage.tsx` | One reply: text, scope bar, report, filters, layout editing, source note. |
| `src/App.tsx` | Message stream, input, prepared buttons, action dispatch. |
| `src/layout/*` | Layout types, defaults, ordering (`arrange`), validation and localStorage (`parse`), OpenPencil mapping. |
| `src/EditLayout.tsx` | The layout editing form (a modal). |
| `vite.config.ts` | Local API: `/api/plan` and `/api/layout/{apply,export,import-fig}` (plus the Retail endpoints, see section 4). |

### 3.9 How to extend

| Goal | Change |
|---|---|
| New component | Add the id to `layout/components.ts` → add the OpenUI component to `report/library.tsx` and register it in `CHILD`, `CONSTRUCTOR` and `TITLES` → default style in `layout/defaults.ts` → its name in `EditLayout.tsx` → tests. The prompt lists `COMPONENTS` automatically, and the subset render test covers the new id. |
| New metric | Calculate it in `metrics.ts` → add it to `METRICS` and `SORTABLE` in `validate.ts` → `KEY` and the card mapping in `model.ts` → `narrative.ts` → a hand-computed expectation in `tests/expected.json`. |
| New analysis type | `INTENTS` in `validate.ts` → `BASE` in `model.ts` → the prompt → `narrative` → tests. |
| Change the sample threshold | `MIN_SAMPLE` in `model.ts`, then update the expected values and assertions. |
| Change model or provider | Only `deepseekComplete` in `planner.ts` (keep `reserve()` and the output validation). |

**After changing the prompt or the request schema, rerun the whole set of demo questions against the real model** (lesson 4 below).

### 3.10 Lessons learned

1. **Blank screen**: the UI indirectly imported `node:fs`. Guarded by `tests/browser-safe.test.ts`.
2. **OpenUI drops unknown components silently** and never calls `onError`. `unknownComponents` checks before rendering.
3. **Concurrent writes to one design file** mixed up data. Layout apply uses a temporary file per request; only export and import share `.scene-data/design.fig`, and the browser tests run serially.
4. **A new `sortBy` caused a regression**: for "dropped the most" the model also returned `sortBy: answer_rate_change`, which was rejected. Only the new phrasing had been tested. Fixed with `normalize()`, the prompt and a full question regression.
5. **A new question silently inherited a narrowed campaign scope.** A new question now defaults to all campaigns.
6. **A ranking changed the rows but not the columns**, leaving unrelated columns. Fixed with `spec.columns`.
7. **A busy machine plus a slow OpenPencil subprocess** made e2e time out, and a leftover Vite server on the port stopped Playwright from starting. Set `SCENE_PORT` instead of stopping a running server.

### 3.11 Known limits

- All components in one report share one date range and one campaign scope; "one card for all, another card for one campaign" is not possible.
- There are only two charts (calls and answered, or calls only); a new chart needs a new component.
- The data is synthetic and "last week" is bound to the fixed reference date.
- A narrow screen layout and embedding the OpenPencil GUI have not been verified.
- `MIN_SAMPLE = 30` and the page size of 10 are assumptions pending business confirmation.

## 4. Retail (v0.3.0 to v0.5.0)

### 4.1 In one sentence

The user chats in plain text. A model reads the message together with the task state and application facts and decides what the turn is. The application validates that decision, computes every number and owns all state. In the default mode a second model call writes the screen as OpenUI Lang, but only out of components and fact bindings the application offers, and only after the application has validated it.

### 4.2 Design principles (read before changing code)

1. **The application owns the facts.** Eligibility, fees, dates, distances, quotes and case numbers come only from `src/retail/rules.ts` and `src/retail/service.ts`. The model extracts an `Intent` or writes wording; it never supplies a figure.
2. **Model output is untrusted input.** Plans go through `parseTurnPlan` and `validateIntent`. Lang programs go through `checkLang`. Nothing is rendered or applied before its check passes, and a rejected program is never shown "partially" (the renderer silently drops unknown parts, so the check must reject them explicitly).
3. **One state, one path.** `TaskState` (`src/retail/state.ts`) is edited by typed language and by components alike. Both end in an `Intent` handled by the same pure function, `applyIntent` (`src/retail/flow.ts`).
4. **Submission is a button.** A case is created only by the application's own "Confirm and submit" (`confirmed: true`), re-validated on the server and idempotent per key and payload. No model output, program, component or event can submit.
5. **No silent fallback.** If the model fails, the user is told and chooses (retry, or use the basic rules for that message). "Understood by model" is shown only with server proof.
6. **Messages are frozen.** Each message keeps the state and facts it was made from. A later change switches its controls off; it never rewrites what it showed.

### 4.3 Modes the user can select

| Header selector | Options | Effect |
|---|---|---|
| `rt-interpreter` | Model (default) / Rules only | Rules only uses `parseIntentLocal` in the browser and makes no model call. |
| `rt-ui-mode` | Model-written (OpenUI, default) / Fixed cards (v0.4) | Fixed cards are the v0.4 components in `cards.tsx`, written by the application. Rules-only also uses them. |
| `rt-scenario` | `standard`, `no_company`, `multi_company`, `submit_fail` | Different saved addresses and a failing submit, for demos and tests. |

The selectors are chosen by the user and shown in the header; the application never switches them on its own.

### 4.4 How a turn flows

Full diagrams are in [SEQUENCE-RETAIL.md](SEQUENCE-RETAIL.md). In short:

- **Typed message, OpenUI mode**: browser `ask()` → `POST /api/retail/interpret` → `runUiTurn` → call 1 (plan, JSON) → application validates, runs read-only queries, previews the change → call 2 (Lang) → `checkLang` (one repair at most) → browser applies the change, freezes the message, renders.
- **Control press**: `uiEvent` → stale check → `eventToIntent` → `applyIntent` → either the application's confirmation card or one Lang call (`runUiEvent`).
- **Typed message, Fixed cards mode**: `runTurn` (plan, plus a compose call when queries ran) → the browser shows application-written cards.
- **Rules only**: `parseIntentLocal` → `applyIntent`, no server call.
- **Submit**: confirmation card → `POST /api/retail/submit` → `submitCase`.

Model calls: a typed OpenUI turn costs 2 (plan + lang), a control press 1 (lang), a repair 1 more. Each is reserved in the budget ledger before it is sent.

### 4.5 Module map

| Path | Role |
|---|---|
| `src/retail/data.ts` | Synthetic orders, addresses, service points, plan terms, scenarios, `RETAIL_TODAY`. |
| `src/retail/rules.ts` | Pure business rules and the simulated quote service: eligibility, fees, ETA, deadlines, appointment windows. The only source of numbers. |
| `src/retail/intent.ts` | `Intent` type, key whitelist and `validateIntent`; the rules-based `parseIntentLocal` fallback. |
| `src/retail/state.ts` | `TaskState`, `nextNeed`, state setters, `revisionOf`, `markAnswered`, `cardLive`, `diffTask`, `reportOf`, `payloadOf`, `readiness`. |
| `src/retail/flow.ts` | `applyIntent`: merges an `Intent` into the task, reports what changed, asks the one next thing. |
| `src/retail/turn.ts` | v0.4 turn planner: read-only tools (`quote_plans`, `service_points`, `policy_terms`), `buildFacts`, `parseTurnPlan`, `guardAnswer` (figure guard), `runTurn`, `parseTask` and `parseHistory` for untrusted browser input. |
| `src/retail/openui/library.tsx` | The OpenUI component library the model may use (18 components). Components show bindings and emit semantic events; they never touch the task. |
| `src/retail/openui/bundle.ts` | `EvidenceBundle`: typed bindings (`order.*`, `quote.*`, `cmp.*`, `sp.*`, `addr.*`, `plan.*`, `opt`, `terms.*`) and the catalog sent to the model. |
| `src/retail/openui/validate.ts` | `checkLang`: the gate every model-written program must pass. |
| `src/retail/openui/events.ts` | `UiEvent`, `Control`, `eventToIntent`. |
| `src/retail/openui/compose.ts` | Server orchestration: `runUiTurn`, `runUiEvent`, `composeLang`, the Lang prompt rules. |
| `src/retail/openui/LangMessage.tsx` | Renders one frozen, validated program with its bundle; shows "How this was made". |
| `src/retail/cards.tsx` | The v0.4 fixed cards, kept as is. |
| `src/retail/RetailApp.tsx` | The chat UI: message stream, `ask`, `applyTurn`, `applyLangTurn`, `uiEvent`, submit. |
| `src/retail/service.ts` | Simulated submit and progress service: re-validates, recomputes the quote, idempotent per key and payload. |
| `src/retail/trace.ts` | Per-request trace (no key, prompt or message text), `checkResponse`, `viaLabel`. |
| `src/retail/context.ts` | Plain-text context for the model in the non-planner path. |
| `vite.config.ts` (`retailApi`) | Local API: `/api/retail/interpret`, `/trace`, `/submit`, `/progress`. The browser never sees the API key. |

### 4.6 Key data structures

- **`TaskState`**: item, symptoms, deadline and departure date, plan, preference, saved address book, `delivery` (where the new item goes) and `pickupAddr` (where the old item is collected) kept separate, `pickup` (method, date, slot, service point), `submit`.
- **`Intent`**: what the user said, as a whitelisted set of keys (`orderId`, `symptoms`, `deadline`, `planChoice`, `returnMethod`, `servicePointId`, `pickupDate`, `pickupSlot`, `deliveryTarget`, ...). Dates only if the user stated them.
- **`Need`**: the single next thing the application waits for (`order`, `symptoms`, `deadline`, `plan`, `method`, `location`, `servicepoint`, `dropdate`, `pickup`, `confirm`), derived by `nextNeed`.
- **`EvidenceBundle`**: the facts a program may point at. Each binding has a kind, and a component accepts only the kinds that fit it, so a total cannot appear as a date.
- **`Control` and `UiEvent`**: `Control` records what a validated program offers; `UiEvent` is what a pressed control emits. `eventToIntent` accepts an event only if a matching control was offered.
- **`LangPayload`**: `program`, `controls`, `bundle`, `stateRevision`, `need`, `attempts`, `repaired`, `errors`, `libraryVersion`. Stored inside the message.
- **`RMsg`**: user, action or agent message. An agent message may carry a card, quick replies, a `memo` (application summary of a what-if, used as model history) or a frozen `lang`.

### 4.7 The validation layers

| Layer | Where | What it stops |
|---|---|---|
| Untrusted browser input | `parseTask`, `parseHistory` | Malformed task state or history sent to the server. |
| Turn plan | `parseTurnPlan`, `validateQuery`, `validateIntent` | Unknown keys, unknown tools or arguments, illegal values. Non-`change` modes drop `changes`. |
| Lang program | `checkLang` | Unknown components, unresolved references, wrong binding kinds, illegal fields, size limits (7000 chars, 40 nodes, depth 4, 6 inputs), figures that are not in the facts, a missing input for the pending `Need`. |
| Pressed control | `eventToIntent`, `revisionOf` | Stale messages, controls the program never offered, illegal values. |
| Figures in wording | `guardAnswer` | Money, dates, days and km that the application did not compute. |
| Submit | `service.ts`, `confirmKey` | Stale confirmation cards, double submit, invalid payloads. |

### 4.8 Conversation state

- `nextNeed` drives the conversation: one question per turn, with the smallest component that answers it.
- `markAnswered` collapses a card once its question is answered, whether by typing or by clicking.
- `cardLive` decides whether a fixed card may still act; for Lang messages the equivalent is `revisionOf(task) === lang.stateRevision` and not locked.
- `plansKey` and `confirmKey` version quotes and the confirmation card, so an outdated quote can never be submitted.
- After submit the task is locked; edits become a "change request" that only records intent.

### 4.9 Observability

- Every interpret request leaves a trace record: request id, whether a model request was really sent, per-call stage, HTTP status, timings, budget reservation number, outcome. Stored in a ring buffer (`GET /api/retail/trace`) and in `.scene-data/retail-trace.jsonl`.
- Raw model programs and validation errors go to `.scene-data/retail-lang.jsonl`.
- `.scene-data/` is runtime state and git-ignored. So is `evidence/`.
- The paid-request ledger is `evidence/MODEL_CALL_BUDGET.json`. Each request is reserved before sending, failures count, and only the user changes the cap.

### 4.10 Verifying changes

| Command | Cost | Covers |
|---|---|---|
| `npm run verify:offline` | 0 | Typecheck, unit tests, offline browser tests against a mock model. Proves wiring and guards only. |
| `npx vite-node scripts/verify-retail-ui-live.ts` | about 2 requests per case | Live check of the Lang prompt, library, validator and planning contract. |
| `RUN_DIR=<dir> SCENE_PORT=5184 npx playwright test -c playwright.live.config.ts e2e-live/retail-openui.spec.ts` | about 10 to 14 requests | Full live vertical slice in the browser (explain, what-if, adopt, store appointment, submit). |

Run the live checks after changing the Lang prompt, the library, the validator or the planning contract. Put evidence in a timestamped `evidence/v0.5.0-<date>-<tag>/` directory and keep failed runs.

### 4.11 How to extend

| Goal | Change |
|---|---|
| New component | `openui/library.tsx` (`defineComponent`, add to `LEAVES` or a container's children) → a `case` in the `walk` in `openui/validate.ts` (unlisted components are rejected as `unknown_component`) → a binding kind in `openui/bundle.ts` if it shows new facts, plus its line in `bindingCatalog` → tests. The Lang prompt lists components automatically from the library. |
| New fact the model may show | Compute it in `rules.ts`, expose it as a binding in `buildBundle`, accept its kind in `checkLang`. Never put a figure in model-written text. |
| New thing to ask for | A key in `Intent` and `validateIntent`, a `nextNeed` branch, an `ask` entry in `flow.ts`, a line in the model prompt, a branch in `requiredControls` (`openui/validate.ts`), and a dialog test. |
| New pressable control | A `UiEvent` and `Control` variant, `eventToIntent`, `checkLang` (so it is recorded as offered), then the component. |
| New demo scenario | `data.ts` (`SCENARIOS`). |

Do not convert fixed cards to Lang, wrap an old card in a component, or add a branch keyed on a particular user sentence (extend the facts or a tool instead).

### 4.12 Known issues and limits (as of 2026-11-12)

- **A strict plan check can fail a whole turn.** On the OpenUI path the planning prompt says to leave out `ui`, but the model sometimes sends `ui:[{"component":"compare"}]` without a declared query. `parseTurnPlan` then rejects the plan (`invalid_turn_plan:compare_needs_a_declared_query`) and the user sees "Model call failed". Observed once in the first live attempt of 2026-11-12 (evidence: `attempt1-failed/`). The OpenUI path does not use `ui` or `quick`, so ignoring them there would avoid this; not yet decided or fixed.
- **The Lang prompt carries generic text that Retail does not use**, taken from the library's default template (streaming and hoisting notes, chart advice). It costs tokens on every call.
- **One live run shows the flow works, not that it is robust.** The 2026-11-12 run was one sample: 10 requests, 2 of them repairs. Robustness across phrasings and repeated runs is unknown.
- The map is schematic (no real routing); the quote service, case store and progress are simulated.
- The UI is English only; the model is told to answer in English even when the user writes in another language.

## 5. Design notes

### 5.1 What each technology is responsible for

- **DeepSeek**: in Reporting it returns a validated JSON analysis plan. In Retail it first returns a JSON task plan, then writes OpenUI Lang from the facts the application provides.
- **OpenUI** (`@openuidev/react-lang`): renders OpenUI Lang into registered components and supports component interaction. Using the OpenUI Renderer does not by itself mean the model generated the UI structure.
- **React**: both modes keep their app shell, state and registered components in React. OpenUI does not replace React. In Reporting, "moving to OpenUI" means using the OpenUI component library and render entry point.
- **OpenPencil**: used for Reporting layout file round trips, import and export, and supported layout edits. The main Retail flow does not use it, and the OpenPencil GUI is not embedded in the chat.

### 5.2 Why does Reporting still turn component ids into OpenUI Lang?

The `calls_card` and `answer_rate_card` the model returns are the application's own business component ids, not a program the OpenUI Renderer can run. For example, the `components` part of a validated plan is:

```json
{"components": ["calls_card", "answer_rate_card"], "only": true}
```

The application's `programFor()` turns the chosen components and their order into:

```text
root = Report([c0, c1])
c0 = MetricCard("calls_card")
c1 = MetricCard("answer_rate_card")
```

`MetricCard` is a component registered with OpenUI, and its string argument decides which application metric it reads; the model does not rewrite the data. **This conversion adapts to the current OpenUI render interface. It is not an extra AI inference and does not give the model more control over layout.** Mapping these ids directly in React would give the same business behaviour; the current implementation simply goes through the OpenUI component registry and render entry point.

So describe today's Reporting as "the model chooses the analysis and components, the application generates the OpenUI Lang", not as "the model generates the whole UI". Only Retail v0.5's Lang is written directly by the model, and its underlying components are likewise implemented in advance by developers.

### 5.3 Model calls per operation

| Operation | Model calls on the normal path | Exceptions and limits |
|---|---:|---|
| Reporting natural-language question | 1 | Prepared-analysis buttons make no model call; a model failure is never shown as a success |
| Reporting filter, sort, page, drill-down | 0 | The application updates or creates the report directly |
| Retail natural language (model-written) | 2 | 1 plan + 1 Lang; a failed Lang check adds at most 1 repair; an early failure can use fewer than 2 |
| Retail next screen after a valid choice | 1 | Skips intent reasoning and only writes Lang; at most 1 repair if needed |
| Retail form draft, reaching confirmation, final submit | 0 | A draft is not a submitted choice; confirmation and submit are handled by the application. A QuickReply of kind `ask` goes through the natural-language path |

One browser HTTP request can contain several model calls. In Retail, "Quick action" means the choice itself ran directly; it does not mean the UI that follows was written without a model call. Check the server trace of that message.

### 5.4 Capabilities, trade-offs and limits

Reporting's component set can change with the user's intent, but the inner structure of components, the default combinations and the layout rules are mostly controlled by the application, so a single model call keeps cost and waiting time easier to control. Retail can generate explanations, hypothetical comparisons, choice controls or an appointment form around the question, which is more flexible, but it adds call cost, waiting time and validation and repair complexity. These are architecture trade-offs, not user benefits that have been measured.

Retail's task order is still constrained by the application's `nextNeed()`; the model cannot invent business processes, components or actions. `discuss` and `what_if` do not modify the task; a change is applied only when the user adopts it or states it explicitly. Fact bindings and figure checks do not guarantee complete semantic correctness, and the model can still misread the facts. Both modes run on synthetic data and a local demo service; offline tests prove wiring and constraints, and real model behaviour needs separate live evidence.

### 5.5 Future direction (not implemented)

To let the model generate structure in Reporting too, keep the existing calculation engine and query validation, then add fact bindings, Lang generation, semantic validation and an event protocol, and define how this works together with OpenPencil layout preferences. Translating component ids into Lang, or turning on `isStreaming`, does not complete that work.
