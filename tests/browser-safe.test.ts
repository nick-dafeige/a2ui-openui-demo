import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Value imports reachable from src/main.tsx. A Node built-in there blank-paged the app once. */
function reachable(entry: string): { files: string[]; nodeImports: string[] } {
  const files: string[] = [], nodeImports: string[] = [], seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return; seen.add(file); files.push(file);
    const src = readFileSync(file, 'utf8');
    const specs = [
      ...src.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm),
      ...src.matchAll(/^import\s+['"]([^'"]+)['"]/gm),
    ].map((m) => m[1]);
    for (const spec of specs) {
      if (spec.startsWith('node:')) nodeImports.push(`${file} -> ${spec}`);
      else if (spec.startsWith('.') && /\.tsx?$/.test(spec)) visit(join(file, '..', spec));
    }
  };
  visit(entry);
  return { files, nodeImports };
}

describe('browser bundle', () => {
  const r = reachable(join(process.cwd(), 'src/main.tsx'));
  it('reaches the app modules', () => expect(r.files.some((f) => f.endsWith('src/App.tsx'))).toBe(true));
  it('imports no Node built-ins', () => expect(r.nodeImports).toEqual([]));
  it('does not reach the paid-call modules', () => expect(r.files.filter((f) => /planner\.ts$|budget\.ts$|env\.ts$/.test(f))).toEqual([]));
});
