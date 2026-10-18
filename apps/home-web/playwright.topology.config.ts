import { defineConfig, devices } from '@playwright/test';

// D-ORG Gate-6 V3 — browser-level verification of the INTEGRATED tenant-host
// bundle: the real nginx front-door image (deploy/nginx/Dockerfile — the five
// baked SPAs + the real aramo.conf.template) served locally, driven by a real
// Chromium. The two backends (auth-service, api) are NOT part of this harness:
// their HTTP surfaces are stubbed at the browser network layer (page.route) with
// the documented response shapes, so what this proves is the FRONT-DOOR + SPA
// behaviour — routing, deep links + refresh through nginx, the consumer header
// each app sends, bookmark forwarding, login/signed-out landings, the relocated
// Organization Administration views and their styling. The backend contracts are
// proven by the auth-service / identity integration suites (real Postgres).
//
// Bring-up (see doc/runbooks/RELEASE-app-home-org.md §"Local browser check"):
//   docker build -f deploy/nginx/Dockerfile -t aramo/nginx:local .
//   DORG_E2E_BASE_URL=https://localhost:8443 npx playwright test --config apps/home-web/playwright.topology.config.ts
const BASE_URL = process.env['DORG_E2E_BASE_URL'] ?? 'https://localhost:8443';
const CHROMIUM = process.env['RC_E2E_CHROMIUM'];

export default defineConfig({
  testDir: './e2e',
  testMatch: /topology\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: './e2e/.evidence/test-results',
  use: {
    baseURL: BASE_URL,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
    ...(CHROMIUM !== undefined ? { launchOptions: { executablePath: CHROMIUM } } : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
