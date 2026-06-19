# Recruiter Console — live integration e2e

The project's first **live** integration test. It drives the **real Cognito
hosted-UI session flow** against the local stack and walks all nav-reachable
recruiter surfaces with a genuine session — no interception, no mocked API, no
minted token.

## What it covers (the things harnesses can't)

- A real Cognito login → genuine HttpOnly session (`auth.setup.ts`).
- `RouteGuard requireScope` gating under real scopes; ForbiddenState for an
  unheld route (data-driven — only asserted if the test user lacks a nav scope).
- ID→name resolution (My Desk, tables) renders **names, not UUIDs**, with a
  **bounded** request fan-out (no N+1 storm).
- empty / loading / error states under **real latency** (lists tolerate empty).
- real response-shape drift — surfaced as console/page errors (the walk fails on
  any).

## Prerequisites

1. The local stack running: `apps/api` on `:3000`, `auth-service` on `:3001`, a
   seeded Postgres, Redis. (The Cognito redirect URIs are pinned to `:4201`, so
   the FE must be served there — the config starts/【reuses】a `:4201` dev server.)
2. A browser for Playwright: `npx playwright install chromium` (or set
   `RC_E2E_CHROMIUM` to an existing Chromium/headless-shell executable).
3. A **dedicated least-privilege test recruiter Cognito user** (recruiter scopes
   only). Provide credentials via env — never commit them:

   ```sh
   export RC_E2E_USERNAME='…'
   export RC_E2E_PASSWORD='…'
   # export RC_E2E_TOTP_SECRET='…'   # only if MFA is enabled for the user
   ```

## Run

```sh
npx nx e2e aramo-ats-web
# or: npx playwright test --config apps/ats-web/playwright.config.ts
```

The real session is saved to `e2e/.auth/recruiter.json` (gitignored — it is a
genuine credential artifact and must never be committed).

## First-run note

Cognito ships two hosted UIs (classic + "managed login"). The selectors in
`cognito-login.ts` try the common shapes of both; if the pool uses a customized
UI, adjust them there (the one place expected to need tuning).
