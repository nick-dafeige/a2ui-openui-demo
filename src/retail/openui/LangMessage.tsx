import { useMemo, useState } from 'react';
import { Renderer } from '@openuidev/react-lang';
import type { TaskState } from '../state.ts';
import type { LangPayload } from './compose.ts';
import { EnvContext, library, type Draft } from './library.tsx';
import type { UiEvent } from './events.ts';

/**
 * One model-written interface inside the chat. The validated program and the facts it was written against are FROZEN with the
 * message: later state changes never rewrite what it shows, they only switch its controls off (`live=false`). The renderer is
 * given a program only after `checkLang` accepted it (nothing streams in unvalidated, so nothing can be pressed early).
 */
export function LangMessage({ lang, state, live, onEvent, requestId }: { lang: LangPayload; state: TaskState; live: boolean; onEvent: (ev: UiEvent, label: string) => void; requestId: string }) {
  const [draft, setDraftState] = useState<Draft>({});
  const env = useMemo(() => ({ bundle: lang.bundle, state, live, emit: onEvent, draft, setDraft: (p: Partial<Draft>) => setDraftState((d) => ({ ...d, ...p })) }), [lang.bundle, state, live, onEvent, draft]);
  return (
    <div className={`ou-msg${live ? '' : ' stale'}`} data-testid="rt-lang" data-live={live ? 'true' : 'false'} data-revision={lang.stateRevision} data-request={requestId}>
      {lang.ok && lang.program ? (
        <EnvContext.Provider value={env}>
          <Renderer response={lang.program} library={library} isStreaming={false} onAction={(e) => {
            const p = e.params as { event?: UiEvent; label?: string } | undefined;
            if (e.type === 'retail_event' && p?.event && live) onEvent(p.event, String(p.label ?? ''));
          }} />
        </EnvContext.Provider>
      ) : <div className="banner error" data-testid="rt-lang-rejected">The interface the model wrote was rejected by the application's checks, so it was not shown.</div>}
      {!live && lang.ok && <div className="muted" data-testid="rt-lang-stale">These options are out of date (something changed since); they are kept as they were shown and cannot be used.</div>}
      <details className="ou-source" data-testid="rt-lang-source">
        <summary>How this was made · {lang.ok ? 'validated' : 'rejected'} · {lang.attempts} model write{lang.attempts === 1 ? '' : 's'}{lang.repaired ? ' (1 repair)' : ''} · {lang.libraryVersion}</summary>
        <pre data-testid="rt-lang-raw">{lang.raw}</pre>
        {lang.errors.length > 0 && <ul data-testid="rt-lang-errors">{lang.errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
      </details>
    </div>
  );
}
