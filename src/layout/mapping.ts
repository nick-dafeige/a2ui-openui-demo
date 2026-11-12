import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { COMPONENT_IDS, PALETTE, type AccentKey, type ComponentId, type Layout, type LayoutItem } from './components.ts';

const run = promisify(execFile);
const CANVAS = 800, GAP = 8, HALF = (CANVAS - GAP) / 2;
const PREFIX = 'scene-';
const bin = (name: string) => join(process.cwd(), 'node_modules/.bin', name);

/** Layout -> HTML that OpenPencil can import. Node name `scene-<id>` is the stable identity. */
export function toDesignHtml(layout: Layout): string {
  const cards = layout.items.map((i) =>
    `<div id="${PREFIX}${i.id}" style="width:${i.width === 'full' ? CANVAS : HALF}px;height:96px;background:${PALETTE[i.accent]}">${i.id}</div>`).join('');
  return `<div id="canvas" style="display:flex;flex-wrap:wrap;width:${CANVAS}px;gap:${GAP}px">${cards}</div>`;
}

export async function writeDesign(layout: Layout, figPath: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'scene-design-'));
  const html = join(dir, 'layout.html');
  await writeFile(html, toDesignHtml(layout));
  await run(bin('openpencil'), ['import', html, '-o', figPath]);
  const pins = layout.items.filter((i) => i.pinned).map((i) => PREFIX + i.id);
  // Pin has no native import form; it is the node's `locked` flag.
  await run(bin('openpencil'), ['eval', figPath, '-w', '-q', '-c',
    `const r=figma.currentPage.children[0];const p=${JSON.stringify(pins)};r.children.forEach(n=>{n.locked=p.includes(n.name)});`]);
}

export interface RawNode { name: string; width: number; locked: boolean; color: { r: number; g: number; b: number } | null }

export async function readDesign(figPath: string): Promise<RawNode[]> {
  const { stdout } = await run(bin('openpencil'), ['eval', figPath, '--json', '-c',
    `return figma.currentPage.children[0].children.map(n=>({name:n.name,width:n.width,locked:!!n.locked,color:(n.fills&&n.fills[0]&&n.fills[0].color)||null}))`]);
  return JSON.parse(stdout) as RawNode[];
}

const hex = (c: { r: number; g: number; b: number }) =>
  '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

export type Mapped = { ok: true; layout: Layout } | { ok: false; message: string };

/** Design edits -> Layout, or a rejection naming what is unsupported (FR-24, FR-32). */
export function mapNodesToLayout(nodes: RawNode[], previous: Layout): Mapped {
  const items: LayoutItem[] = [];
  for (const n of nodes) {
    const id = n.name.startsWith(PREFIX) ? n.name.slice(PREFIX.length) : null;
    if (!id || !(COMPONENT_IDS as readonly string[]).includes(id)) return { ok: false, message: `Unsupported element "${n.name}": only predefined report components can be edited.` };
    const width = Math.abs(n.width - CANVAS) <= 1 ? 'full' : Math.abs(n.width - HALF) <= 1 ? 'half' : null;
    if (!width) return { ok: false, message: `Unsupported width ${Math.round(n.width)}px on "${id}": use half or full width.` };
    const accent = n.color ? (Object.keys(PALETTE) as AccentKey[]).find((k) => PALETTE[k] === hex(n.color!)) : undefined;
    if (!accent) return { ok: false, message: `Unsupported colour on "${id}": pick one of ${Object.keys(PALETTE).join(', ')}.` };
    items.push({ id: id as ComponentId, width, accent, pinned: n.locked });
  }
  const ids = items.map((i) => i.id);
  if (new Set(ids).size !== ids.length) return { ok: false, message: 'Duplicate components are not supported.' };
  const missing = previous.items.filter((p) => !ids.includes(p.id));
  if (missing.length) return { ok: false, message: `Components cannot be deleted in the layout editor: ${missing.map((m) => m.id).join(', ')}.` };
  return { ok: true, layout: { version: 1, items } };
}
