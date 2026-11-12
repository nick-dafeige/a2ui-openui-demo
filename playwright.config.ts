import { defineConfig } from '@playwright/test';

/** Offline browser checks: the dev server runs in stub-fail mode, so no paid model call can happen. */
const PORT = Number(process.env.SCENE_PORT ?? 5173);
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 }, // layout Apply shells out to OpenPencil; slow under machine load
  workers: 1, // export/import tests share one design file
  use: { baseURL: `http://localhost:${PORT}`, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  outputDir: 'evidence/e2e-output',
  reporter: [['list'], ['json', { outputFile: 'evidence/e2e-results.json' }]],
  webServer: { command: 'SCENE_MODEL_MODE=stub-fail npx vite', url: `http://localhost:${PORT}`, reuseExistingServer: false, timeout: 30_000 },
});
