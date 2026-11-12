import { useState } from 'react';
import { PALETTE, type AccentKey, type Layout } from './layout/components.ts';
import { parseLayout } from './layout/parse.ts';

const TITLES: Record<string, string> = {
  calls_card: 'Calls card', answer_rate_card: 'Answer-rate card', conversion_card: 'Conversion-rate card', daily_trend: 'Daily performance',
  daily_call_volume: 'Daily call volume', campaign_table: 'Campaign table', change_ranking: 'Change ranking', call_list: 'Unanswered-call list',
};

/**
 * Separate layout edit view (FR-21). Edits are a draft; Apply sends the draft through OpenPencil on the server
 * (design file written, read back, supported-change check) and only then replaces the live layout.
 */
export function EditLayout({ current, onApply, onCancel }: { current: Layout; onApply: (l: Layout, saveAsPreference: boolean) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<Layout>(current);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const patch = (i: number, p: Partial<Layout['items'][number]>) => setDraft({ ...draft, items: draft.items.map((it, n) => (n === i ? { ...it, ...p } : it)) });
  const move = (i: number, d: -1 | 1) => {
    const j = i + d; if (j < 0 || j >= draft.items.length) return;
    const items = [...draft.items]; [items[i], items[j]] = [items[j], items[i]]; setDraft({ ...draft, items });
  };
  async function call(path: string, body: unknown): Promise<{ ok: boolean; layout?: unknown; message?: string; file?: string }> {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  }
  async function apply(saveAsPreference: boolean) {
    setBusy(true); setMessage(null);
    try {
      const r = await call('/api/layout/apply', { layout: draft });
      const mapped = r.ok ? parseLayout(r.layout) : null;
      if (mapped) onApply(mapped, saveAsPreference);
      else setMessage(r.message ?? 'The layout could not be applied. The previous layout is still in use.');
    } catch (e) { setMessage(`The layout could not be mapped (${(e as Error).message}). The previous layout is still in use.`); }
    finally { setBusy(false); }
  }
  async function importFig() {
    setBusy(true); setMessage(null);
    try {
      const r = await call('/api/layout/import-fig', { previous: draft });
      const mapped = r.ok ? parseLayout(r.layout) : null;
      if (mapped) { setDraft(mapped); setMessage('Imported edits from the OpenPencil file into the draft. Press Apply to use them.'); }
      else setMessage(r.message ?? 'Import failed. The draft and the live layout are unchanged.');
    } catch (e) { setMessage(`Import failed (${(e as Error).message}). The draft and the live layout are unchanged.`); }
    finally { setBusy(false); }
  }
  async function exportFig() {
    setBusy(true);
    try { const r = await call('/api/layout/export', { layout: draft }); setMessage(r.ok ? `Design file written: ${r.file}. Open it in OpenPencil, edit, save, then use Import.` : r.message ?? 'Export failed.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="editview" data-testid="edit-view" role="dialog" aria-label="Edit report layout">
      <header className="top"><h1>Edit layout of this report</h1><span className="badge demo">Order · width · accent colour · pin — query meaning never changes</span></header>
      <div className="editbody">
        <table data-testid="edit-table"><thead><tr><th>Component</th><th>Order</th><th>Width</th><th>Accent</th><th>Pinned</th></tr></thead>
          <tbody>{draft.items.map((it, i) => (
            <tr key={it.id} data-edit-id={it.id}>
              <td>{TITLES[it.id]}</td>
              <td><button aria-label={`Move ${it.id} up`} disabled={i === 0} onClick={() => move(i, -1)} data-testid={`up-${it.id}`}>↑</button>
                  <button aria-label={`Move ${it.id} down`} disabled={i === draft.items.length - 1} onClick={() => move(i, 1)} data-testid={`down-${it.id}`}>↓</button></td>
              <td><select value={it.width} onChange={(e) => patch(i, { width: e.target.value as 'half' | 'full' })} data-testid={`width-${it.id}`}><option value="half">Half</option><option value="full">Full</option></select></td>
              <td><select value={it.accent} onChange={(e) => patch(i, { accent: e.target.value as AccentKey })} data-testid={`accent-${it.id}`} style={{ borderLeft: `8px solid ${PALETTE[it.accent]}` }}>
                {(Object.keys(PALETTE) as AccentKey[]).map((k) => <option key={k} value={k}>{k}</option>)}</select></td>
              <td><input type="checkbox" checked={it.pinned} onChange={(e) => patch(i, { pinned: e.target.checked })} data-testid={`pin-${it.id}`} aria-label={`Pin ${it.id}`} /></td>
            </tr>))}</tbody></table>
        {message && <div className="banner error" role="alert" data-testid="edit-message">{message}</div>}
        <div className="bar">
          <button className="primary" onClick={() => apply(false)} disabled={busy} data-testid="apply">Apply to this report</button>
          <button onClick={() => apply(true)} disabled={busy} data-testid="apply-save">Apply and save as preference for future reports</button>
          <button onClick={onCancel} disabled={busy} data-testid="cancel">Cancel</button>
          <span className="muted">OpenPencil design file:</span>
          <button onClick={exportFig} disabled={busy} data-testid="export-fig">Write design file</button>
          <button onClick={importFig} disabled={busy} data-testid="import-fig">Import edits from file</button>
        </div>
        <div className="muted">Pinned components are placed first in this report. Other reports are not affected unless you save the layout as a preference. Only order, half/full width, palette colour and pin are supported.</div>
      </div>
    </div>
  );
}
