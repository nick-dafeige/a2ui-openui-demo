import { useState, type ReactNode } from 'react';
import { PICKUP_SLOTS, PLAN_LABEL, PLAN_TERMS, RETAIL_TODAY, SERVICE_POINTS, SYMPTOMS, type Address, type PlanId, type SymptomId } from './data.ts';
import type { Intent } from './intent.ts';
import { addressPin, MapView, servicePin } from './MapView.tsx';
import { appointmentSlots, checkDeadline, courierPickupSupported, distanceKm, dateText, earliestPickup, isAddressComplete, isPickupDateValid, latestPickup, money, orderById, marginText, recommend, servicePointsFor, slotAvailable, symptomLabel, ZONE_LABEL, zoneOf, type PlanQuote, type Timing } from './rules.ts';
import { centsWord, daysWord, type QueryResult } from './turn.ts';
import { candidateOrders, effectiveLocation, locationAddress, payloadOf, plansKey, quotesOf, readiness, selectedQuote, setDelivery, setPickup, supportedPoints, type Card, type TaskState } from './state.ts';

export interface CardApi {
  update: (fn: (t: TaskState) => TaskState) => void;                 // local edit that does not answer the question yet
  answer: (text: string, fn: (t: TaskState) => TaskState, from?: Card['type']) => void;   // component answer: same task, then the agent moves on
  quick: (text: string, intent: Intent) => void;                     // quick reply / choice: same handler as typed language
  apply: (text: string, intent: Intent) => void;                     // explicit adoption of a what-if or a suggestion: runs the change, then reports what changed and what stayed
  say: (userText: string, agentText: string) => void;
  reask: (type: Card['type']) => void;                               // "Change": ask that question again
  submit: (card: Card) => void;
  progress: (caseId: string) => void;
}
interface P { card: Card; view: TaskState; current: TaskState; live: boolean; answered: boolean; busy: boolean; api: CardApi; locked: boolean }

const TIMING_TEXT: Record<Timing, string> = { on_time: 'Should arrive in time', late: 'Will likely miss the date', unknown: 'Cannot tell yet', no_device: 'No working device' };
export const hm = (a: Address) => `${a.recipient} · ${a.phone} · ${a.detail} ${a.floor}`;
const inWarranty = (id: string | null) => { const o = orderById(id); return o ? RETAIL_TODAY <= o.warrantyEnd : false; };

function Shell({ title, testId, live, locked, children }: { title: string; testId: string; live: boolean; locked: boolean; children: ReactNode }) {
  return (
    <div className={`rt-card${live ? '' : ' stale'}`} data-testid={testId} data-live={live ? 'true' : 'false'}>
      <div className="rt-card-head"><h3>{title}</h3>{!live && <span className="badge notice" data-testid={`${testId}-stale`}>{locked ? 'Submitted' : 'Updated'}</span>}</div>
      <fieldset disabled={!live} className="rt-fs">{children}</fieldset>
    </div>
  );
}
/** One-line record of an answered question, with a way to change it. */
function Summary({ testId, label, value, onChange, locked, stale }: { testId: string; label: string; value: string; onChange?: () => void; locked: boolean; stale?: boolean }) {
  return (
    <div className="rt-sum" data-testid={testId}>
      <span><span className="muted">{label}</span> <b data-testid={`${testId}-value`}>{value}</b>{stale && <> <span className="badge notice" data-testid={`${testId}-stale`}>{locked ? 'Closed' : 'Updated'}</span></>}</span>
      {onChange && !locked && <button type="button" className="rt-link" data-testid={`${testId}-change`} onClick={onChange}>Change</button>}
    </div>
  );
}
const Quick = ({ items }: { items: { text: string; run: () => void }[] }) => (
  <div className="prepared rt-quick" data-testid="rt-quick">{items.map((q) => <button key={q.text} type="button" onClick={q.run}>{q.text}</button>)}</div>
);

// ---------------- which item ----------------
export function OrdersCard({ view, live, answered, api, locked }: P) {
  if (!live) { const o = orderById(view.orderId); return <Summary testId="rt-orders" label="Item" value={o ? `${o.name} (${inWarranty(o.id) ? 'in warranty' : 'out of warranty'})` : 'not chosen'} locked={locked} onChange={answered ? () => api.reask('orders') : undefined} />; }
  const orders = candidateOrders(view);
  return (
    <Shell title="Which item?" testId="rt-orders" live={live} locked={locked}>
      <div className="rt-group" role="radiogroup" aria-label="Choose item">
        {orders.map((o) => {
          const inW = inWarranty(o.id);
          return (
            <label key={o.id} className="rt-opt" data-testid={`rt-order-${o.id}`}>
              <input type="radio" name={`order-${orders.length}-${view.orderId ?? ''}`} checked={view.orderId === o.id} onChange={() => api.quick(o.name, { orderId: o.id })} />
              <span><b>{o.name}</b><br /><span className="muted">Order {o.id} · Purchased {o.purchased} · </span>
                <span className={`badge ${inW ? 'live' : 'error'}`}>{inW ? `In warranty (until ${o.warrantyEnd})` : `Out of warranty (expired ${o.warrantyEnd})`}</span></span>
            </label>
          );
        })}
      </div>
      {!view.showAllOrders && <Quick items={[{ text: 'Show all my orders', run: () => api.quick('Show all my orders', { changeOrder: true }) }]} />}
    </Shell>
  );
}

// ---------------- what is wrong (multi-choice) ----------------
export function SymptomsCard({ view, live, answered, api, locked }: P) {
  const [draft, setDraft] = useState<SymptomId[]>(view.symptoms);
  if (!live) return <Summary testId="rt-symptoms" label="Problem" value={symptomLabel(view.symptoms, SYMPTOMS) || 'not described'} locked={locked} onChange={answered ? () => api.reask('symptoms') : undefined} />;
  return (
    <Shell title="What is wrong?" testId="rt-symptoms" live={live} locked={locked}>
      <div className="rt-row">{SYMPTOMS.filter((s) => s.id !== 'unsure').map((s) => (
        <label key={s.id} className="rt-chip"><input type="checkbox" data-testid={`rt-symptom-${s.id}`} checked={draft.includes(s.id)}
          onChange={(e) => setDraft(e.target.checked ? [...draft, s.id] : draft.filter((x) => x !== s.id))} />{s.label}</label>
      ))}</div>
      <div className="actions">
        <button type="button" className="primary" data-testid="rt-symptoms-done" disabled={draft.length === 0} onClick={() => api.answer(`Problem: ${symptomLabel(draft, SYMPTOMS)}`, (t) => ({ ...t, symptoms: draft }))}>Done</button>
        <button type="button" data-testid="rt-symptoms-unsure" onClick={() => api.answer('Not sure what\'s wrong', (t) => ({ ...t, symptoms: ['unsure'] }))}>Not sure what's wrong</button>
      </div>
    </Shell>
  );
}

// ---------------- date pickers (latest receive date, drop-off date) ----------------
function DateField({ label, testId, min, max, error, onConfirm, initial }: { label: string; testId: string; min?: string; max?: string; error?: (v: string) => string | null; onConfirm: (v: string) => void; initial?: string | null }) {
  const [v, setV] = useState(initial ?? '');
  const err = v && error ? error(v) : null;
  return (
    <div className="rt-group">
      <label className="rt-datefield">{label}<input type="date" data-testid={`${testId}-input`} min={min} max={max} value={v} onChange={(e) => setV(e.target.value)} /></label>
      {err && <p className="rt-err" role="alert" data-testid={`${testId}-error`}>{err}</p>}
      <button type="button" className="primary" data-testid={`${testId}-confirm`} disabled={!v || !!err} onClick={() => onConfirm(v)}>Confirm date</button>
    </div>
  );
}
export function DeadlineCard({ view, live, answered, api, locked }: P) {
  if (!live) return <Summary testId="rt-deadline" label="Needed by" value={view.deadline ? dateText(view.deadline) : 'not set'} locked={locked} onChange={answered ? () => api.reask('deadline') : undefined} />;
  return (
    <Shell title="Latest day you need it" testId="rt-deadline" live={live} locked={locked}>
      <DateField label="Latest receive date" testId="rt-deadline-date" min={RETAIL_TODAY} initial={view.deadline}
        error={(v) => { const c = checkDeadline(v, view.departDate); return c.ok ? null : c.message; }} onConfirm={(v) => api.quick(`Latest date: ${dateText(v)}`, { deadline: v })} />
      <p className="muted">Reference date (today): {RETAIL_TODAY}.</p>
    </Shell>
  );
}
export function DropDateCard({ view, live, answered, api, locked }: P) {
  const p = view.pickup;
  const sp = SERVICE_POINTS.find((s) => s.id === p.servicePointId);
  if (!live) return <Summary testId="rt-dropdate" label={sp?.appointment ? 'Appointment' : 'Drop-off date'} value={p.date ? `${dateText(p.date)}${p.slot ? `, ${p.slot}` : ''}` : 'not set'} locked={locked} onChange={answered ? () => api.reask('dropdate') : undefined} />;
  if (sp?.appointment) {   // an appointment-only point is not booked until a slot is chosen
    return (
      <Shell title="Book your drop-off" testId="rt-dropdate" live={live} locked={locked}>
        <p className="muted" data-testid="rt-appt-note">{sp.name} needs an appointment (open {sp.hours}). Choose a day, then a time slot.</p>
        <div className="rt-group">
          <label className="rt-datefield">Drop-off date<input type="date" data-testid="rt-dropdate-date-input" min={earliestPickup()} max={latestPickup()} value={p.date ?? ''} onChange={(e) => api.update((t) => setPickup(t, { date: e.target.value || null }))} /></label>
        </div>
        <div className="rt-group" role="radiogroup" aria-label="Appointment time slot">
          {isPickupDateValid(p.date) ? appointmentSlots(sp.id, p.date).map(({ slot: s, ok }) => {
            return <label key={s} className="rt-chip"><input type="radio" name="appt" data-testid={`rt-appt-${s}`} disabled={!ok} checked={p.slot === s} onChange={() => api.answer(`Appointment: ${dateText(p.date!)}, ${s}`, (t) => setPickup(t, { slot: s }))} />{s}{ok ? '' : ' (full)'}</label>;
          }) : <span className="muted">Choose a date to see the appointment slots</span>}
        </div>
      </Shell>
    );
  }
  return (
    <Shell title="Drop-off date" testId="rt-dropdate" live={live} locked={locked}>
      <DateField label="Drop-off date" testId="rt-dropdate-date" min={earliestPickup()} max={latestPickup()} initial={p.date}
        error={(v) => (isPickupDateValid(v) ? null : `Choose a day between ${dateText(earliestPickup())} and ${dateText(latestPickup())}.`)} onConfirm={(v) => api.quick(`Drop-off: ${dateText(v)}`, { pickupDate: v })} />
    </Shell>
  );
}

// ---------------- compare plans ----------------
function PlanRow({ q, view, rec, live, api }: { q: PlanQuote; view: TaskState; rec: boolean; live: boolean; api: CardApi }) {
  const f = q.fees;
  return (
    <label className={`rt-plan${q.eligible ? '' : ' off'}${rec ? ' rec' : ''}`} data-testid={`rt-plan-${q.plan}`} data-eligible={q.eligible ? 'true' : 'false'} data-timing={q.timing}>
      <input type="radio" name="plan" disabled={!q.eligible || !live} checked={view.planId === q.plan} onChange={() => api.quick(`Choose ${PLAN_LABEL[q.plan]}`, { planChoice: q.plan })} data-testid={`rt-plan-radio-${q.plan}`} />
      <div>
        <div className="rt-plan-head"><b>{PLAN_LABEL[q.plan]}</b>
          {rec && <span className="badge live" data-testid="rt-recommended">Recommended</span>}
          <span className={`badge ${q.eligible ? 'live' : 'error'}`}>{q.eligible ? 'Available' : 'Not available'}</span>
          {q.eligible && <span className={`badge rt-timing-${q.timing}`} data-testid={`rt-timing-${q.plan}`}>{TIMING_TEXT[q.timing]}</span>}</div>
        {!q.eligible ? <p className="rt-err" data-testid={`rt-reason-${q.plan}`}>Reason: {q.reason}</p> : (
          <>
            <p className="rt-fees" data-testid={`rt-fees-${q.plan}`}>
              Shipping {money(f.shippingCents)} · Service fee {money(f.serviceCents)} · Total <b>{money(f.totalCents)}</b>
              {f.refundCents !== null && <> · Estimated refund <b>{money(f.refundCents)}</b></>}</p>
            <p className="rt-steps muted" data-testid={`rt-steps-${q.plan}`}>{q.steps.map((s) => `${dateText(s.date)} ${s.label}`).join(' → ')}</p>
            <p className="muted" data-testid={`rt-eta-${q.plan}`}>{q.etaLabel}: {dateText(q.etaDate!)} (estimate, not a delivery guarantee){q.pickupAssumed && q.plan !== 'exchange' ? ' · based on the earliest pickup day' : ''}</p>
          </>
        )}
      </div>
    </label>
  );
}
export function PlansCard({ card, view, current, live, answered, api, locked }: P) {
  const quotes = quotesOf(view);
  const rec = recommend(quotes, view.deadline, view.preference);
  const q = selectedQuote(view);
  if (!live && answered && view.planId && !locked) {   // the latest answered comparison reads as the chosen plan, with today's numbers
    return <Summary testId="rt-plans" label="Plan" value={`${PLAN_LABEL[view.planId]}${q?.etaDate ? ` · ${q.etaLabel.toLowerCase()} ${dateText(q.etaDate)}` : ''} · ${q ? money(q.fees.refundCents ?? q.fees.totalCents) : ''}`} locked={locked} onChange={() => api.reask('plans')} />;
  }
  if (!live) { // an unanswered or closed comparison whose numbers no longer apply: one line, marked, no actions
    const then = quotesOf(card.snapshot).filter((x) => x.eligible).map((x) => `${PLAN_LABEL[x.plan]} ${x.plan === 'refund' ? money(x.fees.refundCents!) : `${dateText(x.etaDate!)} ${money(x.fees.totalCents)}`}`).join(' · ');
    return <Summary testId="rt-plans" label="Earlier comparison" value={then} locked={locked} stale={plansKey(card.snapshot) !== plansKey(current)} />;
  }
  return (
    <Shell title="Compare your options" testId="rt-plans" live={live} locked={locked}>
      <p className="rt-rec" data-testid="rt-rec-text">{rec.text}</p>
      <div className="rt-plans" role="radiogroup" aria-label="Choose a service plan">{quotes.map((q) => <PlanRow key={q.plan} q={q} view={view} rec={rec.planId === q.plan} live={live} api={api} />)}</div>
      <Quick items={[
        ...(rec.planId ? [{ text: `Choose ${PLAN_LABEL[rec.planId]}`, run: () => api.quick(`Choose ${PLAN_LABEL[rec.planId!]}`, { planChoice: rec.planId! }) }] : []),
        { text: 'Fastest first', run: () => api.quick('Fastest first', { preference: 'fastest' }) },
        { text: 'Lowest cost first', run: () => api.quick('Lowest cost first', { preference: 'cheapest' }) },
        { text: 'View plan terms', run: () => api.quick('View plan terms', { showTerms: true }) },
        { text: 'I have a question first', run: () => api.quick('I have a question first', { askQuestion: true }) },
      ]} />
    </Shell>
  );
}

// ---------------- delivery address of the new item ----------------
const blank = (kind: Address['kind']): Address => ({ id: `new-${kind}`, kind, label: kind === 'company' ? 'Company · New' : 'New address', recipient: '', phone: '', detail: '', floor: '', x: 50, y: 50 });
export function AddressCard({ card, view, live, busy, api, locked }: P) {
  const mode = card.mode ?? 'edit';
  const [selId, setSelId] = useState<string | null>(mode === 'choose' || mode === 'fill' ? null : view.delivery.id);
  const [draft, setDraft] = useState<Address>(mode === 'fill' ? blank('company') : { ...view.delivery });
  if (!live) return <Summary testId="rt-address" label="Delivery to" value={`${view.delivery.label} (${ZONE_LABEL[zoneOf(view.delivery)]})`} locked={locked} />;
  const isNew = selId === null || selId.startsWith('new-');
  const quotes = quotesOf(view).filter((q) => q.needsDelivery && q.eligible);
  const choose = (a: Address) => { setSelId(a.id); setDraft({ ...a }); api.answer(`Delivery to: ${a.label}`, (t) => setDelivery(t, a), 'address'); };
  const complete = isAddressComplete(draft);
  const save = () => {
    const saved: Address = isNew ? { ...draft, id: `${draft.kind}-${draft.x}-${draft.y}`, label: draft.label.replace('New', 'Custom') } : draft;
    api.answer(`Delivery to: ${saved.label}`, (t) => ({ ...setDelivery(t, saved), book: t.book.some((a) => a.id === saved.id) ? t.book.map((a) => (a.id === saved.id ? saved : a)) : [...t.book, saved] }), 'address');
    setSelId(saved.id); setDraft(saved);
  };
  const field = (k: 'recipient' | 'phone' | 'detail' | 'floor', label: string) => (
    <label className="rt-field">{label}<input type="text" data-testid={`rt-addr-${k}`} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} /></label>
  );
  const list = mode === 'choose' ? view.book.filter((a) => a.kind === 'company') : view.book;
  const showForm = mode === 'fill' || (mode === 'edit' && isNew);
  const showList = mode === 'choose' || mode === 'edit';
  const pins = [...view.book.map((a) => addressPin(a, a.id === view.delivery.id && !isNew)), ...(mode === 'single' ? [] : SERVICE_POINTS.map((s) => servicePin(s, false))),
    ...(isNew && (draft.x !== 50 || draft.y !== 50) ? [{ id: 'picked', x: draft.x, y: draft.y, label: 'Picked spot', kind: 'picked' as const, selected: true }] : [])];
  return (
    <Shell title={mode === 'fill' ? 'Enter a company delivery address' : mode === 'choose' ? 'Which company address?' : 'Delivery address for the new item'} testId="rt-address" live={live} locked={locked}>
      {mode === 'single' && <p data-testid="rt-addr-summary"><b>{view.delivery.label}</b> ({ZONE_LABEL[zoneOf(view.delivery)]})<br /><span className="muted">{hm(view.delivery)}</span></p>}
      <div className="rt-addr-grid">
        <div>
          {showList && (
            <div className="rt-group" role="radiogroup" aria-label="Choose delivery address">
              {list.map((a) => (
                <label key={a.id} className="rt-opt" data-testid={`rt-addr-opt-${a.id}`}>
                  <input type="radio" name="addr" checked={selId === a.id} onChange={() => choose(a)} />
                  <span><b>{a.label}</b> ({ZONE_LABEL[zoneOf(a)]})<br /><span className="muted">{hm(a)}</span></span>
                </label>
              ))}
              {mode === 'edit' && <label className="rt-opt" data-testid="rt-addr-opt-new"><input type="radio" name="addr" checked={isNew} onChange={() => { setSelId('new-custom'); setDraft(blank('custom')); }} /><span><b>Use a new address</b></span></label>}
            </div>
          )}
          {showForm && (
            <div className="rt-group" data-testid="rt-addr-form">
              <h4>Click the map to pick a location, then confirm door number, floor and contact details</h4>
              <div className="rt-form">{field('recipient', 'Recipient')}{field('phone', 'Phone')}{field('detail', 'Address')}{field('floor', 'Floor / room')}</div>
              {!complete && <p className="rt-err" data-testid="rt-addr-incomplete">Recipient, phone (7-15 digits or "-"), address and floor/room are all required before this address can be used.</p>}
              <button type="button" data-testid="rt-addr-save" disabled={!complete} onClick={save}>Save and use this address</button>
            </div>
          )}
        </div>
        <MapView testId="rt-address-map" caption="Schematic map (demo): shows delivery locations and service points, not a live delivery track."
          pins={pins} onPin={(id) => { const a = view.book.find((x) => x.id === id); if (a && showList) choose(a); }} onPick={isNew && showForm ? (x, y) => setDraft((d) => ({ ...d, x, y })) : undefined} />
      </div>
      {view.planId !== 'refund' && view.orderId && (
        <div className="rt-recalc" data-testid="rt-recalc" aria-busy={busy}>
          <b>{busy ? 'Recalculating cost and estimated dates…' : isNew ? `No new address chosen yet; still using the current delivery address (${view.delivery.label})` : 'Recalculated for this delivery address'}</b>
          {!busy && quotes.map((q) => (
            <p key={q.plan} data-testid={`rt-recalc-${q.plan}`} className={q.timing === 'late' ? 'rt-err' : ''}>
              {PLAN_LABEL[q.plan]}: {q.etaLabel} {dateText(q.etaDate!)} · Total {money(q.fees.totalCents)} · {TIMING_TEXT[q.timing]}
              {q.timing === 'late' && view.deadline ? ` (after ${dateText(view.deadline)}; try another address or another plan)` : ''}</p>
          ))}
        </div>
      )}
      <Quick items={[
        { text: 'Use company address', run: () => api.quick('Use company address', { deliveryTarget: 'company' }) },
        { text: 'Use home address', run: () => api.quick('Use home address', { deliveryTarget: 'home' }) },
        ...(mode !== 'edit' ? [{ text: 'Change address', run: () => api.quick('Change address', { addressEdit: true }) }] : []),
      ]} />
    </Shell>
  );
}

// ---------------- sending the old item back ----------------
export function PickupCard({ view, live, answered, api, locked }: P) {
  const p = view.pickup;
  if (!live) return <Summary testId="rt-pickup" label="Courier pickup" value={p.date && p.slot ? `${dateText(p.date)}, ${p.slot}` : 'not set'} locked={locked} onChange={answered ? () => api.reask('pickup') : undefined} />;
  const courierOk = courierPickupSupported(view.pickupAddr);
  return (
    <Shell title="Courier pickup" testId="rt-pickup" live={live} locked={locked}>
      <p className="muted" data-testid="rt-pickup-from">Collected from: {hm(view.pickupAddr)} (saved separately from the delivery address)</p>
      {!courierOk && <p className="rt-err">Courier pickup is not available at this (remote) address. Try dropping it off instead.</p>}
      <div className="rt-group">
        <label className="rt-datefield">Pickup date<input type="date" data-testid="rt-pickup-date" min={earliestPickup()} max={latestPickup()} value={p.date ?? ''} onChange={(e) => api.update((t) => setPickup(t, { date: e.target.value || null }))} /></label>
        <span className="muted"> Available {earliestPickup()} to {latestPickup()}</span>
      </div>
      <div className="rt-group" role="radiogroup" aria-label="Pickup time slot">
        {isPickupDateValid(p.date) ? PICKUP_SLOTS.map((s) => {
          const ok = slotAvailable(p.date!, s);
          return <label key={s} className="rt-chip"><input type="radio" name="slot" data-testid={`rt-slot-${s}`} disabled={!ok} checked={p.slot === s} onChange={() => api.answer(`Pickup: ${dateText(p.date!)}, ${s}`, (t) => setPickup(t, { slot: s }))} />{s}{ok ? '' : ' (full)'}</label>;
        }) : <span className="muted">Choose a pickup date to see the time slots</span>}
      </div>
    </Shell>
  );
}
export function ServicePointsCard({ card, view, live, answered, api, locked }: P) {
  const sp = SERVICE_POINTS.find((s) => s.id === view.pickup.servicePointId);
  if (!live) return <Summary testId="rt-servicepoints" label="Drop-off at" value={sp ? `${sp.name} · ${sp.hours}` : 'not chosen'} locked={locked} onChange={answered ? () => api.reask('servicepoints') : undefined} />;
  const loc = effectiveLocation(view) ?? 'home';
  const from = locationAddress(view, loc);
  const points = [...supportedPoints(view)].filter((s) => !card.ids || card.ids.includes(s.id)).sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y));
  const pick = (id: string) => { const s = SERVICE_POINTS.find((x) => x.id === id)!; api.quick(s.name, { servicePointId: id }); };
  return (
    <Shell title={`Service points near your ${loc}`} testId="rt-servicepoints" live={live} locked={locked}>
      <div className="rt-addr-grid">
        <div role="radiogroup" aria-label="Service points">{points.map((s, n) => (
          <label key={s.id} className="rt-opt" data-testid={`rt-sp-${s.id}`}>
            <input type="radio" name="sp" checked={view.pickup.servicePointId === s.id} onChange={() => pick(s.id)} />
            <span><b>{s.name}</b>{n === 0 && <span className="badge live"> Closest</span>}<br />
              <span className="muted">{s.detail} · {distanceKm(s, from)} km from your {loc} · Open {s.hours}</span><br />
              <span className={`badge ${s.appointment ? 'notice' : 'live'}`}>{s.appointment ? 'Appointment required' : 'Walk-in OK'}</span>{' '}
              <span className="muted">Handles: {s.supports.map((p) => PLAN_LABEL[p].toLowerCase()).join(', ')}</span></span>
          </label>
        ))}</div>
        <MapView testId="rt-sp-map" caption={`Schematic map (demo): service points near your ${loc}.`} pins={[addressPin({ ...from, label: loc === 'company' ? 'Company' : 'Home' }, false), ...points.map((s) => servicePin(s, s.id === view.pickup.servicePointId))]}
          onPin={(id) => { if (points.some((s) => s.id === id)) pick(id); }} />
      </div>
    </Shell>
  );
}

// ---------------- final summary ----------------
export function ConfirmCard({ card, view, live, busy, api, locked }: P) {
  const payload = payloadOf(view);
  const q = selectedQuote(view);
  const order = orderById(view.orderId);
  const sub = view.submit;
  const submitting = sub.status === 'submitting';
  const sp = payload ? SERVICE_POINTS.find((s) => s.id === payload.pickup.servicePointId) : undefined;
  return (
    <Shell title="Confirm and submit" testId="rt-confirm" live={live} locked={locked}>
      {!payload || !q || !order ? <p className="rt-err">Not complete yet: {readiness(view)[0]}</p> : (
        <>
          <dl className="rt-dl" data-testid="rt-confirm-dl">
            <dt>Item and fault</dt><dd data-testid="rt-c-item">{order.name} (order {order.id}) · {symptomLabel(payload.symptoms, SYMPTOMS)}</dd>
            <dt>Plan</dt><dd data-testid="rt-c-plan">{PLAN_LABEL[payload.planId]}</dd>
            <dt>{payload.planId === 'refund' ? 'Refund amount' : 'Cost'}</dt>
            <dd data-testid="rt-c-fee">{payload.planId === 'refund' ? `Estimated refund ${money(q.fees.refundCents!)}` : `Shipping ${money(q.fees.shippingCents)} + service fee ${money(q.fees.serviceCents)} = ${money(q.fees.totalCents)}`}</dd>
            <dt>Pickup</dt><dd data-testid="rt-c-pickup">{payload.pickup.method === 'courier'
              ? <>{hm(payload.pickupAddr)}<br />Courier pickup · {payload.pickup.date} {payload.pickup.slot}</>
              : <>You drop it off · {payload.pickup.date}{payload.pickup.slot ? ` ${payload.pickup.slot}` : ''}<br />{sp?.name} · {sp?.detail} · Open {sp?.hours}{sp?.appointment ? ` · Appointment ${payload.pickup.slot ? 'booked' : 'required'}` : ''}</>}</dd>
            {payload.delivery && <><dt>Delivery</dt><dd data-testid="rt-c-delivery">{hm(payload.delivery)}<br />{q.etaLabel} {dateText(q.etaDate!)} (estimate, not a delivery guarantee)</dd></>}
            {!payload.delivery && <><dt>{q.etaLabel}</dt><dd data-testid="rt-c-eta">{dateText(q.etaDate!)} (estimate)</dd></>}
            <dt>Latest receive date</dt>
            <dd data-testid="rt-c-deadline" className={q.timing === 'late' ? 'rt-err' : ''}>{dateText(payload.deadline)} · {q.timing === 'on_time' ? 'expected to be met' : q.timing === 'late' ? 'expected to be missed' : 'a refund gives no working headphones, so the need is not solved'}</dd>
            <dt>Key terms</dt><dd><ul className="rt-terms">{PLAN_TERMS[payload.planId].map((x) => <li key={x}>{x}</li>)}</ul></dd>
          </dl>
          {q.timing === 'late' && <p className="banner error" role="alert">Heads-up: this plan is expected to miss your latest receive date. You can still submit, or choose another plan first.</p>}
        </>
      )}
      {sub.status === 'failed' && live && (
        <div className="banner error" role="alert" data-testid="rt-submit-error">
          {sub.message}<br /><b>{sub.created === false ? 'Request not created.' : 'We cannot confirm whether the request was created; retrying uses the same submit key and will not create a duplicate.'}</b> What you entered is kept.
        </div>
      )}
      <Quick items={[
        { text: payload?.pickup.method === 'store' ? 'Change drop-off date' : 'Change time', run: () => api.answer('Change time', (t) => setPickup(t, { date: null, slot: null })) },
        { text: 'Choose another plan', run: () => api.answer('Choose another plan', (t) => ({ ...t, planId: null })) },
      ]} />
      <p className="muted">Demo environment: pressing the button only creates a request in the simulated service; nothing is really refunded, shipped or booked.</p>
      <div className="actions">
        <button type="button" className="primary" data-testid="rt-submit" disabled={!live || busy || submitting || !payload} onClick={() => api.submit(card)}>
          {submitting ? 'Submitting…' : sub.status === 'failed' ? 'Retry submit' : 'Confirm and submit'}</button>
        {busy && <span className="muted"> Recalculating…</span>}
      </div>
    </Shell>
  );
}

// ---------------- result, terms, progress, change ----------------
export function ReceiptCard({ card, api }: P) {
  const r = card.record!;
  const sp = SERVICE_POINTS.find((s) => s.id === r.pickup.servicePointId);
  return (
    <div className="rt-card rt-receipt" data-testid="rt-receipt">
      <div className="rt-card-head"><h3>After-sales request receipt (demo)</h3><span className="badge live">Returned by the simulated service</span></div>
      <dl className="rt-dl">
        <dt>Request number</dt><dd data-testid="rt-r-id"><b>{r.id}</b></dd>
        <dt>Order and item</dt><dd data-testid="rt-r-item">{r.itemName} (order {r.orderId}) · {r.symptoms}</dd>
        <dt>Plan</dt><dd data-testid="rt-r-plan">{r.planLabel}</dd>
        <dt>Status</dt><dd data-testid="rt-r-status">{r.status}</dd>
        <dt>{r.planId === 'refund' ? 'Refund amount' : 'Cost'}</dt><dd data-testid="rt-r-fee">{r.planId === 'refund' ? `Estimated refund ${money(r.refundCents!)}` : `Shipping ${money(r.shippingCents)} + service fee ${money(r.serviceCents)} = ${money(r.totalCents)}`}</dd>
        <dt>Pickup</dt><dd data-testid="rt-r-pickup">{r.pickup.method === 'courier'
          ? <>{hm(r.pickupAddr)}<br />Courier pickup · {r.pickup.date} {r.pickup.slot}</>
          : <>You drop it off · {r.pickup.date}{r.pickup.slot ? ` ${r.pickup.slot}` : ''}<br />{sp?.name} · {sp?.detail} · Open {sp?.hours}{sp?.appointment ? ` · Appointment ${r.pickup.slot ? 'booked' : 'required'}` : ''}</>}</dd>
        {r.delivery && <><dt>Delivery</dt><dd data-testid="rt-r-delivery">{hm(r.delivery)}</dd></>}
        <dt>{r.etaLabel}</dt><dd data-testid="rt-r-eta">{r.etaDate ? `${dateText(r.etaDate)} (estimate, not a delivery guarantee)` : '—'}</dd>
        <dt>Next steps</dt><dd><ul className="rt-terms">{r.nextSteps.map((s) => <li key={s.label + s.date}>{dateText(s.date)} {s.label}</li>)}</ul></dd>
      </dl>
      <p className="muted">Demo environment: no real refund, shipment or booking.</p>
      <Quick items={[{ text: 'View progress', run: () => api.progress(r.id) }]} />
    </div>
  );
}
export function TermsCard() {
  return (
    <div className="rt-card" data-testid="rt-terms">
      <div className="rt-card-head"><h3>Plan terms</h3></div>
      {(['exchange', 'repair', 'refund'] as PlanId[]).map((p) => <div key={p}><b>{PLAN_LABEL[p]}</b><ul className="rt-terms">{PLAN_TERMS[p].map((x) => <li key={x}>{x}</li>)}</ul></div>)}
    </div>
  );
}
export function ProgressCard({ card }: P) {
  return <div className="rt-card" data-testid="rt-progress"><div className="rt-card-head"><h3>Request progress (demo)</h3></div><ul className="rt-terms">{(card.progress ?? []).map((l) => <li key={l}>{l}</li>)}</ul></div>;
}
export function ChangeCard({ view, api }: P) {
  const rec = view.submit.status === 'done' ? view.submit.record : null;
  return (
    <div className="rt-card" data-testid="rt-change">
      <div className="rt-card-head"><h3>Change request (demo)</h3></div>
      <p>Request {rec?.id} has been submitted and its receipt cannot be edited directly. A change is handled as a separate change request.</p>
      <button type="button" data-testid="rt-change-start" onClick={() => api.say('Start change request (demo)', `Change intent noted (demo: request ${rec?.id} is not modified and no new request is created).`)}>Start change request (demo)</button>
    </div>
  );
}


// ---------------- what-if comparison (data comes from an application tool result, never from model wording) ----------------
export function CompareCard({ card, api, locked }: P) {
  const r = card.data as QueryResult | undefined;
  if (!r) return null;
  if ('error' in r) return <div className="rt-card" data-testid="rt-compare"><p className="rt-err">That comparison could not be evaluated ({r.error}).</p></div>;
  if (r.tool === 'quote_plans') {
    return (
      <div className="rt-card rt-compare" data-testid="rt-compare" data-tool="quote_plans">
        <div className="rt-card-head"><h3>If: {r.assumptions.join(' and ')}</h3><span className="badge notice" data-testid="rt-compare-badge">What-if only · nothing was changed</span></div>
        {r.deadlineText && <p className="muted">Latest receive date: {r.deadlineText}</p>}
        <table data-testid="rt-compare-table">
          <thead><tr><th>Plan</th><th>Now</th><th>If this</th><th>Difference</th><th>Timing</th></tr></thead>
          <tbody>{r.rows.map((x) => (
            <tr key={x.plan} data-testid={`rt-compare-row-${x.plan}`}>
              <td><b>{x.label}</b></td>
              {x.eligible ? <>
                <td>{x.plan === 'refund' ? `refund ${x.etaNow}` : x.etaNow} · {x.totalNow}</td>
                <td>{x.plan === 'refund' ? `refund ${x.etaAlt}` : x.etaAlt} · {x.totalAlt}</td>
                <td>{x.deltaDays != null ? daysWord(x.deltaDays) : '—'} · {centsWord(x.deltaCents)}</td>
                <td>{x.plan === 'refund' ? 'No working device' : x.marginAltDays == null ? TIMING_TEXT[x.timingAlt] : marginText(x.marginAltDays)}</td>
              </> : <td colSpan={4} className="rt-err">Not available: {x.reason}</td>}
            </tr>))}</tbody>
        </table>
        {r.applyIntent && !locked && <div className="actions"><button type="button" className="primary" data-testid="rt-compare-apply" onClick={() => api.apply(`Apply: ${r.assumptions.join(' and ')}`, r.applyIntent!)}>Apply this change</button><span className="muted"> Nothing changes unless you press this.</span></div>}
      </div>
    );
  }
  if (r.tool === 'service_points') {
    return (
      <div className="rt-card rt-compare" data-testid="rt-compare" data-tool="service_points">
        <div className="rt-card-head"><h3>Service points near your {r.nearLabel}</h3><span className="badge notice" data-testid="rt-compare-badge">Comparison only · nothing was changed</span></div>
        <table data-testid="rt-compare-table">
          <thead><tr><th>Service point</th><th>Distance</th><th>Open</th><th>Appointment</th><th>Handles {r.plan ? PLAN_LABEL[r.plan].toLowerCase() : 'your plan'}</th><th /></tr></thead>
          <tbody>{r.points.map((p) => (
            <tr key={p.id} data-testid={`rt-compare-row-${p.id}`}>
              <td><b>{p.name}</b><br /><span className="muted">{p.detail}</span></td><td>{p.distanceKm} km</td><td>{p.hours}</td>
              <td>{p.appointment ? 'Required' : 'Walk-in OK'}</td><td>{p.supportsPlan === null ? '—' : p.supportsPlan ? 'Yes' : 'No'}</td>
              <td>{p.supportsPlan !== false && !locked && <button type="button" data-testid={`rt-compare-use-${p.id}`} onClick={() => api.apply(`Use ${p.name}`, { servicePointId: p.id })}>Use this one</button>}</td>
            </tr>))}</tbody>
        </table>
      </div>
    );
  }
  return <div className="rt-card" data-testid="rt-compare" data-tool="policy_terms">{r.terms.map((x) => <div key={x.plan}><b>{x.label}</b><ul className="rt-terms">{x.lines.map((l) => <li key={l}>{l}</li>)}</ul></div>)}</div>;
}
