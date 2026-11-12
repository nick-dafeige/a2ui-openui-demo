import { COMPONENT_IDS, PALETTE, type Layout, type LayoutItem } from './components.ts';
import { defaultLayout } from './defaults.ts';

/** Browser-safe validation of an untrusted layout (localStorage, request bodies). Returns null if unusable. */
export function parseLayout(raw: unknown): Layout | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { version?: unknown; items?: unknown };
  if (r.version !== 1 || !Array.isArray(r.items)) return null;
  const items: LayoutItem[] = [];
  for (const it of r.items) {
    if (typeof it !== 'object' || it === null) return null;
    const { id, width, accent, pinned } = it as Record<string, unknown>;
    if (!(COMPONENT_IDS as readonly unknown[]).includes(id)) return null;
    if (width !== 'half' && width !== 'full') return null;
    if (typeof accent !== 'string' || !(accent in PALETTE)) return null;
    if (typeof pinned !== 'boolean') return null;
    items.push({ id: id as LayoutItem['id'], width, accent: accent as LayoutItem['accent'], pinned });
  }
  const ids = items.map((i) => i.id);
  if (new Set(ids).size !== ids.length || ids.length !== COMPONENT_IDS.length) return null; // exactly one entry per component
  return { version: 1, items };
}

export const LAYOUT_STORAGE_KEY = 'scene.layout.v1';

export function loadLayout(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): Layout {
  try {
    const raw = storage?.getItem(LAYOUT_STORAGE_KEY);
    return (raw && parseLayout(JSON.parse(raw))) || defaultLayout();
  } catch { return defaultLayout(); } // storage blocked or JSON corrupt: fall back to the default layout
}
export function saveLayout(layout: Layout, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): boolean {
  try { storage?.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout)); return !!storage; } catch { return false; }
}
function safeStorage(): Storage | undefined { try { return globalThis.localStorage; } catch { return undefined; } }
