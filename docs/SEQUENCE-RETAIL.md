# Retail sequence diagrams (v0.5.0, model-written interface)

> Based on reading the code on 2026-11-12, cross-checked against a real run the same day (6 turns, 10 model requests, 2 repairs; evidence is kept locally under `evidence/`, which is not committed).
> Related files: `src/retail/RetailApp.tsx`, `vite.config.ts` (`retailApi`), `src/retail/openui/compose.ts`, `validate.ts`, `events.ts`, `bundle.ts`, `library.tsx`, `LangMessage.tsx`, `src/retail/turn.ts`, `flow.ts`.
> The Reporting counterpart is in [SEQUENCE-REPORTING.md](SEQUENCE-REPORTING.md).

## 1. A typed message

Two model calls per turn: the first decides what the user meant, the second writes the screen. The server never changes any state. The browser applies the change itself with the same pure function, `applyIntent`.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant B as Browser (RetailApp)
  participant S as Server (retailApi, compose.ts)
  participant M as DeepSeek

  U->>B: types a message
  B->>B: add user message (pending)
  B->>S: POST /api/retail/interpret<br/>message, history, task, ui=openui
  S->>S: parseTask, parseHistory, reserve budget
  S->>M: call 1 plan (forced JSON)<br/>STATE, PENDING, FACTS, history
  M-->>S: mode, changes, queries
  S->>S: parseTurnPlan (key whitelist, validateIntent)
  S->>S: runQueries (quote_plans, service_points, policy_terms)
  alt mode = change
    S->>S: applyIntent noAsk to preview the new state, reportOf
  end
  S->>S: buildBundle: bindings the model may point at
  S->>M: call 2 lang (free text)<br/>BINDINGS, TURN, NEED, NEEDDETAIL
  M-->>S: OpenUI Lang program
  S->>S: checkLang: library, binding kinds,<br/>figures vs facts, required input for NEED
  opt program rejected
    S->>M: repair (at most 1) with the error list
    M-->>S: corrected program
    S->>S: checkLang again
  end
  S-->>B: plan, lang (program, controls, bundle, revision), trace
  B->>B: checkResponse (request id, server proof)
  alt mode = change
    B->>B: applyIntent noAsk, markAnswered
    B-->>U: "Changed: ... Unchanged: ..." message
  end
  alt lang.ok
    B->>B: freeze program + bundle + state snapshot in the message
    B-->>U: Renderer draws components from bindings
  else rejected twice
    B-->>U: "interface was rejected" + the fixed card for the pending question
  end
```

Key points:

- **Model proposes**: steps 5 and 11. Both outputs are untrusted text and do not reach the user until a check passes.
- **Application decides**: steps 6 to 10 and 13. The whitelists, the read-only tools, the state change and the figure guard are plain code.
- **discuss and what_if turns**: the `alt` branch is skipped and any `changes` from the model are dropped, so these turns cannot alter state.

## 2. A control press, then submit

Buttons, pickers and choices inside the screen emit an event. The event is checked, turned into the same `Intent` that typed text would produce, and only then does the model write what comes next, in one call.

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant B as Browser (uiEvent)
  participant S as Server (runUiEvent)
  participant M as DeepSeek

  U->>B: presses a control in a Lang message
  B->>B: stale? revision differs or submitted
  alt stale
    B-->>U: "options were out of date, nothing changed"
  else current
    B->>B: eventToIntent: control was offered,<br/>ref maps to a binding, validateIntent
    alt invalid
      B-->>U: "that choice was not valid, nothing changed"
    else valid
      B-->>U: user message with the button label
      B->>B: applyIntent noAsk, markAnswered
      B-->>U: "Changed: ..." plus the application's notes
      alt need = confirm
        B-->>U: confirmation card (application-owned)
      else more is needed
        B->>S: POST interpret with event, ui=openui
        S->>M: lang call only (no plan step)
        M-->>S: program
        S->>S: checkLang (one repair if rejected)
        S-->>B: lang payload
        B-->>U: next frozen message, earlier ones go inactive
      end
    end
  end

  U->>B: presses Confirm and submit
  B->>B: not double click, card not stale, payload ready
  B->>S: POST /api/retail/submit confirmed=true, idempotency key
  S->>S: revalidate, create case once per key and payload
  alt created
    S-->>B: record
    B-->>U: receipt
  else failed
    S-->>B: message, created = no or unknown
    B-->>U: "Request not created" or "creation unknown"
  end
```

Key points:

- **One path for state**: typed text and pressed controls both end in `applyIntent`, so a control cannot do anything the typed route could not.
- **Only the application submits**: the model can write a button, but submission exists only on the application's own Confirm card, and the server validates it again.
- **Frozen history**: each Lang message keeps its own bundle and state snapshot, and its controls switch off once the task revision moves on.

## 3. Model calls per scenario

| Scenario | Model calls |
|---|---|
| A typed turn | 2 (plan + lang) |
| A control press | 1 (lang) |
| Validation failure | up to 1 more (repair) |
| Rules-only mode | 0 |
