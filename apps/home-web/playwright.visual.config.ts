import { defineConfig, devices } from '@playwright/test';

// TEMPLATE-STUDIO-1 (PO/Lead scope ruling 2026-10-27) — visual baselines of the
// Organization Template Studio + Template gallery (e2e/visual/org-template-studio.spec.ts),
// mirroring apps/platform-web/playwright.config.ts: the app is served by the Vite dev
// server and every API call is answered by page.route (e2e/visual/org-studio-fixtures.ts).
// No backend, no Cognito, no network beyond Google Fonts.
//
//   nx run aramo-home-web:e2e-visual                      compare
//   nx run aramo-home-web:e2e-visual -- --update-snapshots re-record (deliberate only)

const PORT = Number(process.env['PW_E2E_PORT'] ?? 4296);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e/visual',
  testMatch: /\.spec\.ts$/,
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  fullyParallel: true,
  workers: process.env['CI'] ? 2 : 4,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    // The platform suite's settings (anti-aliasing only): threshold 0.2, ≤25 pixels.
    toHaveScreenshot: { threshold: 0.2, maxDiffPixels: 25, animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../dist/e2e/home-web/report' }]],
  outputDir: process.env['PW_OUT'] ?? '../../dist/e2e/home-web/results',
  use: {
    baseURL: BASE_URL,
    timezoneId: 'UTC',
    locale: 'en-US',
    colorScheme: 'light',
    contextOptions: { reducedMotion: 'reduce' },
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    deviceScaleFactor: 1,
    viewport: { width: 1440, height: 900 },
  },
  // Glyph rasterisation noise under load (the platform suite's Lead ruling 2026-10-24).
  projects: [{ name: 'visual', retries: 2 }],
  webServer: {
    command: `npx vite --config apps/home-web/vite.config.ts --port ${PORT} --strictPort`,
    cwd: '../..',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
