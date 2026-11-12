import { defineConfig } from '@playwright/test';

/** PAID: real DeepSeek calls through the app (each question = 1 reserved request). Run only deliberately. */
const PORT = Number(process.env.SCENE_PORT ?? 5173);
export default defineConfig({
  testDir: 'e2e-live',
  timeout: 60_000,
  workers: 1,
  use: { baseURL: `http://localhost:${PORT}`, screenshot: 'on', video: 'on', trace: 'retain-on-failure' },
  outputDir: 'evidence/e2e-live-output',
  reporter: [['list'], ['json', { outputFile: 'evidence/e2e-live-results.json' }]],
  webServer: { command: 'SCENE_MODEL_MODE=live npx vite', url: `http://localhost:${PORT}`, reuseExistingServer: false, timeout: 30_000 },
});
