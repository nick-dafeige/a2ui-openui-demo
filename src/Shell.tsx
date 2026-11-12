import { useEffect, useState } from 'react';
import { App } from './App.tsx';
import { RetailApp } from './retail/RetailApp.tsx';

type Mode = 'reporting' | 'retail';
const fromHash = (): Mode => (location.hash === '#/retail' ? 'retail' : 'reporting');

/**
 * Mode switch (v0.3.0). Both modes stay mounted once opened (hidden, not unmounted) so switching never loses a
 * conversation. The retail mode is only mounted after its first visit; Reporting is untouched by this wrapper.
 */
export function Shell() {
  const [mode, setMode] = useState<Mode>(fromHash);
  const [retailSeen, setRetailSeen] = useState(fromHash() === 'retail');
  useEffect(() => {
    const on = () => { const m = fromHash(); setMode(m); if (m === 'retail') setRetailSeen(true); };
    window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on);
  }, []);
  const pick = (m: Mode) => { setMode(m); if (m === 'retail') setRetailSeen(true); try { history.replaceState(null, '', m === 'retail' ? '#/retail' : '#/'); } catch { /* ignore */ } };
  return (
    <div className="shell">
      <nav className="modebar" role="tablist" aria-label="Mode">
        <span className="modebar-title">Scene</span>
        {(['reporting', 'retail'] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'tab on' : 'tab'} data-testid={`mode-${m}`} onClick={() => pick(m)}>
            {m === 'reporting' ? 'Reporting' : 'Retail'}</button>
        ))}
      </nav>
      <div className="shell-pane" hidden={mode !== 'reporting'} data-testid="pane-reporting"><App /></div>
      {retailSeen && <div className="shell-pane" hidden={mode !== 'retail'} data-testid="pane-retail"><RetailApp /></div>}
    </div>
  );
}
