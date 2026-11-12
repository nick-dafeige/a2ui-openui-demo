import type { CallRecord } from './data/generate.ts';
import { campaignName } from './report/model.ts';

/** Expands inside the report message that owns the call list. */
export function CallDetail({ call, onClose }: { call: CallRecord; onClose: () => void }) {
  return (
    <section className="detail" aria-label="Call detail" data-testid="call-detail">
      <div className="bar"><strong>Call detail</strong><button onClick={onClose} data-testid="close-detail">Close</button></div>
      <dl>
        <dt>Call ID</dt><dd data-testid="detail-id">{call.id}</dd>
        <dt>Campaign</dt><dd>{campaignName(call.campaignId)}</dd>
        <dt>Started (UTC)</dt><dd>{call.startedAt.replace('T', ' ').replace('Z', '')}</dd>
        <dt>Outcome</dt><dd data-testid="detail-outcome">{call.outcome}</dd>
        <dt>Phone (synthetic)</dt><dd>{call.phone}</dd>
        <dt>Duration</dt><dd>{call.durationSec ? `${call.durationSec}s` : '—'}</dd>
        <dt>Converted</dt><dd>{call.converted ? 'Yes' : 'No'}</dd>
      </dl>
      <div className="muted">Synthetic demo record. No recording or personal data.</div>
    </section>
  );
}
