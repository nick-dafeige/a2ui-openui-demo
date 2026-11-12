import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.ts';

describe('loadEnv', () => {
  it('loads names, strips quotes, never overrides, returns names only', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'env-')), '.env');
    writeFileSync(f, '# c\nDEEPSEEK_API_KEY="placeholder-key"\nEXISTING=new\nEMPTY=\n');
    const env: Record<string, string | undefined> = { EXISTING: 'old' };
    expect(loadEnv(f, env as NodeJS.ProcessEnv)).toEqual(['DEEPSEEK_API_KEY']);
    expect(env.DEEPSEEK_API_KEY).toBe('placeholder-key');
    expect(env.EXISTING).toBe('old');
  });
  it('returns nothing when the file is missing', () => expect(loadEnv('/nonexistent/.env', {})).toEqual([]));
});
