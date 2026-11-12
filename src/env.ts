import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Loads KEY=VALUE lines from a .env file into process.env without overriding existing variables.
 * File: $SCENE_ENV_FILE, else ./.env (git-ignored). Values are never logged or returned.
 */
export function loadEnv(file = process.env.SCENE_ENV_FILE ?? join(process.cwd(), '.env'), env = process.env): string[] {
  if (!existsSync(file)) return [];
  const loaded: string[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (env[m[1]] === undefined && value !== '') { env[m[1]] = value; loaded.push(m[1]); }
  }
  return loaded; // names only
}
