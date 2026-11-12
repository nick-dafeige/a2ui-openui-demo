import { defineConfig, type Plugin } from 'vite';
import { loadEnv } from './src/env.ts';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepseekComplete, deepseekLang, planQuestion, type Complete } from './src/ai/planner.ts';
import { mapNodesToLayout, readDesign, writeDesign } from './src/layout/mapping.ts';
import { parseLayout } from './src/layout/parse.ts';
import { parseHistory, parseTask, runTurn, type TurnOutcome } from './src/retail/turn.ts';
import { runUiEvent, runUiTurn } from './src/retail/openui/compose.ts';
import { buildServerTrace, newRequestId, validRequestId, type ModelEvent, type ServerTrace } from './src/retail/trace.ts';
import { CaseStore, caseProgress, submitCase } from './src/retail/service.ts';

/**
 * Local planner endpoint: the browser never sees the API key. SCENE_MODEL_MODE:
 *   live (default) = real DeepSeek call (reserves budget), stub-fail / stub-invalid = offline failure injection for tests.
 * There is deliberately no stub that returns a successful plan labelled "live".
 */
function plannerApi(): Plugin {
  return {
    name: 'scene-planner-api',
    configureServer(server) {
      loadEnv();
      server.middlewares.use('/api/plan', (req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          const send = (status: number, obj: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
          try {
            const { question, selectedCampaignId } = JSON.parse(body) as { question: string; selectedCampaignId?: string };
            const mode = process.env.SCENE_MODEL_MODE ?? 'live';
            const complete: Complete = mode === 'stub-fail' ? async () => { throw new Error('http_503'); }
              : mode === 'stub-invalid' ? async () => 'this is not json'
              : deepseekComplete({ reserveStage: 'app-question' });
            send(200, await planQuestion(String(question).slice(0, 500), complete, { selectedCampaignId }));
          } catch (e) { send(200, { kind: 'failed', reason: `server_error: ${(e as Error).message}` }); }
        });
      });
    },
  };
}

/**
 * Retail demo endpoints (v0.3.0). interpret = model extracts an Intent (validated; stub modes for offline tests);
 * submit/progress = the simulated after-sales service with an in-memory store (no real refund, shipment or booking).
 */
function retailApi(): Plugin {
  const store = new CaseStore();
  const body = (req: import('node:http').IncomingMessage) => new Promise<unknown>((resolve) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
  });
  return {
    name: 'scene-retail-api',
    configureServer(server) {
      loadEnv();
      const send = (res: import('node:http').ServerResponse, o: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      // Every interpret request leaves one trace record (ring buffer + .scene-data/retail-trace.jsonl). No key, prompt or message text.
      const traces: ServerTrace[] = [];
      const record = (t: ServerTrace) => {
        traces.push(t); if (traces.length > 200) traces.shift();
        try { mkdirSync(DESIGN_DIR, { recursive: true }); appendFileSync(join(DESIGN_DIR, 'retail-trace.jsonl'), JSON.stringify(t) + '\n'); } catch { /* tracing must never break the app */ }
        server.config.logger.info(`[retail-interpret] ${t.requestId} mode=${t.mode} modelCalled=${t.modelCalled} outcome=${t.outcome}${t.failure ? ` failure=${t.failure}` : ''} total=${t.totalMs}ms`);
      };
      server.middlewares.use('/api/retail/interpret', async (req, res) => {
        const t0 = Date.now(); const at = new Date().toISOString();
        const b = (await body(req)) as { message?: unknown; history?: unknown; task?: unknown; requestId?: unknown; ui?: unknown; event?: unknown } | null;
        const header = req.headers['x-request-id'];
        const requestId = [Array.isArray(header) ? header[0] : header, b?.requestId].find(validRequestId) ?? newRequestId();
        const message = String(b?.message ?? '').slice(0, 500);
        const mode = (process.env.SCENE_MODEL_MODE ?? 'live') as ServerTrace['mode'];
        const calls: { stage: 'plan' | 'compose' | 'lang' | 'repair'; events: ModelEvent[] }[] = [];
        let outcome: TurnOutcome, contextChars = 0;
        try {
          const task = parseTask(b?.task);
          const history = parseHistory(b?.history);
          if (!task) outcome = { kind: 'failed', reason: 'bad_task_state', stages: [] };
          else if (mode === 'stub-fail') outcome = { kind: 'failed', reason: 'stub-fail: model disabled (offline test mode), no request was sent', stages: [] };
          else if (mode === 'stub-invalid') outcome = { kind: 'failed', reason: 'stub-invalid: model disabled (offline test mode), no request was sent', stages: [] };
          else {
            contextChars = JSON.stringify({ task, history }).length;
            const call = async (stage: 'plan' | 'compose' | 'lang' | 'repair', system: string, user: string) => {
              const entry = { stage, events: [] as ModelEvent[] }; calls.push(entry);
              const make = stage === 'lang' || stage === 'repair' ? deepseekLang : deepseekComplete;   // Lang is free text (not forced JSON); both reserve budget first and are traced per call
              return make({ reserveStage: `retail-turn:${stage}`, trace: (e) => entry.events.push(e), timeoutMs: 60_000 })(system, user);
            };
            const ev = b?.event as { report?: unknown; notes?: unknown } | undefined;
            if (b?.ui === 'openui' && ev && typeof ev === 'object') outcome = await runUiEvent({ message, history, task, report: typeof ev.report === 'string' ? ev.report.slice(0, 600) : null, notes: typeof ev.notes === 'string' ? ev.notes.slice(0, 600) : '' }, call);
            else if (b?.ui === 'openui') outcome = await runUiTurn({ message, history, task }, call);
            else outcome = await runTurn({ message, history, task }, call);
            const lang = (outcome as { lang?: { raw: string; ok: boolean; errors: string[] } }).lang;
            if (lang) { try { mkdirSync(DESIGN_DIR, { recursive: true }); appendFileSync(join(DESIGN_DIR, 'retail-lang.jsonl'), JSON.stringify({ requestId, at, ok: lang.ok, errors: lang.errors, raw: lang.raw }) + '\n'); } catch { /* evidence capture must never break the app */ } }
          }
        } catch (e) { outcome = { kind: 'failed', reason: `server_error: ${(e as Error).message}`, stages: [] }; }
        const trace = buildServerTrace({ requestId, at, mode, messageChars: message.length, contextChars, calls, outcome: outcome.kind === 'turn' ? outcome : { kind: 'failed', reason: outcome.reason }, model: 'deepseek-chat', totalMs: Date.now() - t0 });
        record(trace);
        res.setHeader('x-request-id', requestId);
        const { stages: _s, ...rest } = outcome as TurnOutcome & { stages?: unknown };
        send(res, { ...rest, trace });
      });
      server.middlewares.use('/api/retail/trace', (req, res) => {
        const id = new URL(req.url ?? '', 'http://x').searchParams.get('requestId');
        send(res, { traces: id ? traces.filter((t) => t.requestId === id) : traces.slice(-100) });
      });
      server.middlewares.use('/api/retail/submit', async (req, res) => {
        const b = (await body(req)) as { key?: unknown; scenario?: unknown; payload?: unknown; confirmed?: unknown } | null;
        send(res, submitCase(store, { key: b?.key as string, scenario: String(b?.scenario ?? 'standard'), payload: b?.payload, confirmed: b?.confirmed }));
      });
      server.middlewares.use('/api/retail/progress', (req, res) => {
        const id = new URL(req.url ?? '', 'http://x').searchParams.get('id') ?? '';
        send(res, caseProgress(store, id));
      });
    },
  };
}
const DESIGN_DIR = join(process.cwd(), '.scene-data');
const DESIGN_FILE = join(DESIGN_DIR, 'design.fig');

/**
 * Layout endpoints. The design file is the OpenPencil side of the mapping: every applied layout is written to it
 * and read back through the supported-change check before it reaches the live report (FR-24, FR-32).
 */
function layoutApi(): Plugin {
  const read = (req: import('node:http').IncomingMessage) => new Promise<unknown>((resolve) => {
    let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
  });
  return {
    name: 'scene-layout-api',
    configureServer(server) {
      const route = (path: string, fn: (b: any) => Promise<unknown>) => server.middlewares.use(path, async (req, res) => {
        const send = (o: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
        try { send(await fn(await read(req))); }
        catch (e) { send({ ok: false, message: `The design could not be mapped to the report (${(e as Error).message}). The previous layout stays.` }); }
      });
      route('/api/layout/apply', async (b) => {
        const layout = parseLayout(b?.layout);
        if (!layout) return { ok: false, message: 'Unsupported layout. The previous layout stays.' };
        // Per-request file: concurrent applies must never read each other's design (a shared file raced in tests).
        const dir = mkdtempSync(join(tmpdir(), 'scene-apply-'));
        try {
          const file = join(dir, 'apply.fig');
          await writeDesign(layout, file);
          const m = mapNodesToLayout(await readDesign(file), layout);
          if (m.ok) { mkdirSync(DESIGN_DIR, { recursive: true }); await writeDesign(m.layout, DESIGN_FILE); } // keep the shared design file in step
          return m.ok ? { ok: true, layout: m.layout } : { ok: false, message: m.message };
        } finally { rmSync(dir, { recursive: true, force: true }); }
      });
      route('/api/layout/export', async (b) => {
        const layout = parseLayout(b?.layout);
        if (!layout) return { ok: false, message: 'Unsupported layout.' };
        mkdirSync(DESIGN_DIR, { recursive: true });
        await writeDesign(layout, DESIGN_FILE);
        return { ok: true, file: '.scene-data/design.fig' };
      });
      route('/api/layout/import-fig', async (b) => {
        const previous = parseLayout(b?.previous);
        if (!previous) return { ok: false, message: 'Unsupported draft layout.' };
        if (!existsSync(DESIGN_FILE)) return { ok: false, message: 'No design file yet. Press "Write design file" first.' };
        const m = mapNodesToLayout(await readDesign(DESIGN_FILE), previous);
        return m.ok ? { ok: true, layout: m.layout } : { ok: false, message: m.message };
      });
    },
  };
}
export default defineConfig({ plugins: [plannerApi(), layoutApi(), retailApi()], server: { port: Number(process.env.SCENE_PORT ?? 5173), strictPort: true }, test: { exclude: ['e2e/**', 'e2e-live/**', 'node_modules/**'] } });
