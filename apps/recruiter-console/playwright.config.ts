import { defineConfig, devices } from '@playwright/test';

// Recruiter Console — LIVE integration e2e (the project's first).
//
// Drives the REAL Cognito hosted-UI session flow against the local stack
// (apps/api :3000 + auth-service :3001) through the recruiter-console dev
// server on :4201 (the Cognito redirect URIs are pinned to :4201). This is the
// real session flow — NOT interception/mocking and NOT a minted token.
//
// Credentials are EXTERNALIZED via env (never committed, never in the PR):
//   RC_E2E_USERNAME, RC_E2E_PASSWORD  — a dedicated least-privilege test
//                                       recruiter Cognito user (recruiter
//                                       scopes only)
//   RC_E2E_TOTP_SECRET  — optional base32 TOTP seed (omit if MFA disabled)
//   RC_E2E_BASE_URL     — override the app origin (default http://localhost:4201)
//   RC_E2E_CHROMIUM     — optional explicit Chromium executablePath (else
//                         Playwright's resolved browser; `npx playwright install
//                         chromium` if absent)
//
// The auth `setup` project performs the login once and saves a real session
// storageState; the `chromium` project reuses it for the surface walk.

const BASE_URL = process.env['RC_E2E_BASE_URL'] ?? 'http://localhost:4201';
const CHROMIUM = process.env['RC_E2E_CHROMIUM'];
const AUTH_STATE = 'apps/recruiter-console/e2e/.auth/recruiter.json';

export default defineConfig({
  testDir: './e2e',
  // Live, ordered, single-worker: the login + surface walk is a sequence
  // against shared real state, not an isolated unit matrix.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(CHROMIUM !== undefined
      ? { launchOptions: { executablePath: CHROMIUM } }
      : {}),
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts$/ },
    {
      name: 'chromium',
      testMatch: /surfaces\.spec\.ts$/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: AUTH_STATE },
    },
  ],
  // Start the FE dev server (it proxies /auth → :3001 and /v1 → :3000). The
  // backends + DB must be running externally; reuse an already-running :4201.
  webServer: {
    command:
      'npx vite --config apps/recruiter-console/vite.config.ts --port 4201 --strictPort',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
