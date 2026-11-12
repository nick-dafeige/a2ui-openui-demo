/** One request to a RUNNING dev server (default :5173) to confirm it serves the v0.5.0 interface turn. Costs at most 2 reserved requests when the server is in live mode; prints only verdicts. */
import { scenarioById } from '../src/retail/data.ts';
import { initialTask, setPlan } from '../src/retail/state.ts';
const port = process.env.PORT ?? '5173';
const t0 = initialTask(scenarioById('standard'));
const task = { ...setPlan({ ...t0, orderId: 'RT-20260620-1001', symptoms: ['one_side_silent'], deadline: '2026-11-16', delivery: t0.book[1] }, 'exchange'), submit: { status: 'idle' } };
const id = `rq-probe-${Date.now().toString(36)}`;
const res = await fetch(`http://localhost:${port}/api/retail/interpret`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': id }, body: JSON.stringify({ message: 'Why does a replacement suit a trip better than a repair?', history: [], task, requestId: id, ui: 'openui' }) });
const j = await res.json() as { kind: string; reason?: string; lang?: { ok: boolean; components: string[]; attempts: number }; trace?: { modelCalled: boolean; mode: string; calls: { stage: string }[] } };
console.log(JSON.stringify({ port, kind: j.kind, reason: j.reason, serverMode: j.trace?.mode, modelCalled: j.trace?.modelCalled, stages: j.trace?.calls.map((c) => c.stage), langOk: j.lang?.ok, components: j.lang?.components }));
