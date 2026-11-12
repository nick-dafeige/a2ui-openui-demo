import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Layout } from '../src/layout/components.ts';
import { mapNodesToLayout, readDesign, writeDesign } from '../src/layout/mapping.ts';

const base: Layout = { version: 1, items: [
  { id: 'answer_rate_card', width: 'half', accent: 'brand', pinned: false },
  { id: 'daily_trend', width: 'full', accent: 'green', pinned: false },
  { id: 'campaign_table', width: 'full', accent: 'amber', pinned: false },
] };
let fig = '';
beforeAll(async () => { fig = join(await mkdtemp(join(tmpdir(), 'scene-t-')), 'd.fig'); await writeDesign(base, fig); }, 60_000);
const edit = (code: string) => execFileSync(join(process.cwd(), 'node_modules/.bin/openpencil'), ['eval', fig, '-w', '-q', '-c', code]);

describe('OpenPencil <-> Layout mapping (real CLI, offline)', () => {
  it('round-trips an unedited design to the same layout', async () => {
    const m = mapNodesToLayout(await readDesign(fig), base);
    expect(m).toEqual({ ok: true, layout: base });
  }, 60_000);

  it('applies order, width, accent and pin edits', async () => {
    edit(`const r=figma.currentPage.children[0];const c=r.children.find(n=>n.name==="scene-answer_rate_card");
      r.insertChild(0,r.children.find(n=>n.name==="scene-campaign_table"));
      c.resize(800,c.height);c.fills=[{type:"SOLID",color:{r:0.862745,g:0.14902,b:0.14902}}];c.locked=true;`);
    const m = mapNodesToLayout(await readDesign(fig), base);
    expect(m.ok).toBe(true);
    if (m.ok) {
      expect(m.layout.items.map((i) => i.id)).toEqual(['campaign_table', 'answer_rate_card', 'daily_trend']);
      expect(m.layout.items.find((i) => i.id === 'answer_rate_card')).toEqual({ id: 'answer_rate_card', width: 'full', accent: 'red', pinned: true });
    }
  }, 60_000);

  it('rejects an off-palette colour and keeps the data meaning out of it', async () => {
    edit(`const n=figma.currentPage.children[0].children.find(n=>n.name==="scene-daily_trend");n.fills=[{type:"SOLID",color:{r:0.5,g:0.5,b:0.5}}];`);
    const m = mapNodesToLayout(await readDesign(fig), base);
    expect(m).toMatchObject({ ok: false });
    expect((m as any).message).toContain('colour');
  }, 60_000);

  it('rejects unknown elements and arbitrary widths without needing the editor', () => {
    expect(mapNodesToLayout([{ name: 'Rectangle 1', width: 800, locked: false, color: null }], base)).toMatchObject({ ok: false });
    expect(mapNodesToLayout([{ name: 'scene-daily_trend', width: 333, locked: false, color: { r: 0.086, g: 0.639, b: 0.29 } }], base)).toMatchObject({ ok: false });
  });
  it('rejects deleting a component', () => {
    const r = mapNodesToLayout([{ name: 'scene-daily_trend', width: 800, locked: false, color: { r: 0.086275, g: 0.639216, b: 0.290196 } }], base);
    expect(r).toMatchObject({ ok: false });
  });
});
