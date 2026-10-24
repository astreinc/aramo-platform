import { defineConfig, devices } from '@playwright/test';

// PLATFORM-UX-1 H-1 — the platform console's hardening suites (directive §3, §7):
//   e2e/visual      pixel parity vs the design file (Platform Admin.dc.html)
//   e2e/a11y        axe (0 serious / 0 critical)
//   e2e/keyboard    keyboard-only journeys (implementation prompt §5)
//   e2e/responsive  900px pass (no page scroll, tables scroll in their card)
//
// The build is served by the Vite dev server and every API call is answered by
// the test-only fixture provider (e2e/fixtures/mock-api.ts, Playwright
// page.route). No backend, no Cognito, no network beyond Google Fonts (the design
// file and the app load the same Hanken Grotesk / IBM Plex Mono).
//
// Reference images: e2e/visual/__screenshots__/<state>-<viewport>.png are the
// design file rendered by `e2e/visual/capture-reference.ts`
// (nx run aramo-platform-web:e2e-visual-reference).

const PORT = Number(process.env['PW_E2E_PORT'] ?? 4290);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  snapshotPathTemplate: '{testDir}/visual/__screenshots__/{arg}{ext}',
  fullyParallel: true,
  workers: process.env['CI'] ? 2 : 4,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    // Anti-aliasing only (directive §3.2: ≤1px edge differences, no layout shift):
    //   threshold 0.2      pixelmatch's per-pixel YIQ colour distance; a pixel
    //                      counts as different only beyond it (glyph-edge
    //                      rasterisation noise stays under it);
    //   maxDiffPixels 25   at most 25 such pixels in the whole frame — a moved,
    //                      missing or recoloured element (a 1px-shifted word is
    //                      ≥100 px) always fails. PW_STRICT=1 → maxDiffPixels 0
    //                      for diagnosis.
    // Glyph rasterisation varies run to run under machine load (measured 61–255
    // scattered glyph-edge pixels, no layout shift). Lead ruling 2026-10-24: the
    // visual project retries a failed comparison up to twice, so random noise
    // clears while a real difference fails all three attempts. A state whose
    // text rasterises differently on EVERY run (the prototype and the build
    // split text into different runs) carries a documented per-state
    // `aaAllowance` (see e2e/visual/DIVERGENCES.md); nothing else is loosened.
    toHaveScreenshot: { threshold: 0.2, maxDiffPixels: 25, animations: 'disabled', caret: 'hide', scale: 'css' },
  },
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../../dist/e2e/platform-web/report' }]],
  outputDir: process.env['PW_OUT'] ?? '../../dist/e2e/platform-web/results',
  use: {
    baseURL: BASE_URL,
    timezoneId: 'UTC',
    locale: 'en-GB',
    colorScheme: 'light',
    contextOptions: { reducedMotion: 'reduce' },
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    deviceScaleFactor: 1,
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'visual', testMatch: /visual\/.*\.spec\.ts$/, retries: 2 },
    { name: 'a11y', testMatch: /a11y\/.*\.spec\.ts$/ },
    { name: 'keyboard', testMatch: /keyboard\/.*\.spec\.ts$/ },
    { name: 'responsive', testMatch: /responsive\/.*\.spec\.ts$/ },
  ],
  webServer: {
    command: `npx vite --config apps/platform-web/vite.config.ts --port ${PORT} --strictPort`,
    cwd: '../..',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
