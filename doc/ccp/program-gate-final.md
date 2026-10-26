# CCP final integrated gate (2026-10-26)

**Gate head:** `105b382e` (Merge CCP-A9-FIX into `feat/ccp-commercial-control-plane`). The commit that records this
file and fills the D6 placeholders is documentation only, on top of it.

**Run window:** 2026-10-26 04:13–04:51 UTC, on the shared development host, with host load 3–20 (other sessions).
All runs were sequential, except vitest `--maxWorkers=3`. Working tree clean (`dirty=0`) before and after.

**Not authorized and not done:** push, PR, merge to main, production migration, deploy, bootstrap, backfill,
activation. **HALT after this record** (Architect scope-freeze directive, `doc/ccp/decisions.md`).

## 1. Program content at the gate head

| Merge | Commit | Record |
|---|---|---|
| R-SYNC (origin/main `ac24e234`) | `eefa795d` | TD-MERGE-46 |
| W-1 labelling of D2 + scope freeze | `30df7a36` | TD-MERGE-47 |
| DG (refund dual gate) | `5d0da43c` | TD-MERGE-48 |
| R3-W (W-2 / W-3) | `1d25faad` | TD-MERGE-49 |
| C8-PR (PAYMENT_RECORD) | `3b779004` | TD-MERGE-50 |
| UI-V12 (CCP-UI v1.2) | `c8034b4d` | TD-MERGE-51 |
| D6 (checklist, rollout plan, register) | `13b0150b` | docs |
| Runbook refresh (bootstrap, migration validation, dark state) | `95f8bc7a` | docs |
| A9-FIX (TD-A9-7) | `105b382e` | TD-MERGE-52 |

## 2. Build, lint and gates

| Check | Result |
|---|---|
| `npm run prisma:validate` / `prisma:generate` | rc=0 / rc=0 |
| CI-simulated build: `nx run-many -t build --all --skip-nx-cache` | 90 projects (+1 dependency task), rc=0 |
| Lint: `nx run-many -t lint --all --skip-nx-cache` | 110 projects (+1 dependency task), rc=0 |
| `tsc -p apps/platform-web/e2e/tsconfig.json` | rc=0 |
| contract-parity, openapi drift, orphan scopes, env passthrough, error codes, tests:integration, repo-map | all rc=0 |
| `openapi:validate` (9 specs), `openapi:lint` | rc=0, rc=0 |
| aggregate-gate, pg-test-image | rc=0, rc=0 |
| Vocabulary (`scripts/verify-vocabulary.sh`, whole tree) | rc=0 |

## 3. Migrations from scratch (fresh Postgres 17.11)

- Shared database: **344 / 344 applied, 0 errors**.
- `intelligence-core` (its own database): **4 / 4, 0 errors**.
- **29 CCP migrations**, in apply order, the last being `subscription/20261030010000_ccp_c8pr_payment_record`.
- The D5 runbook carries the stop point `--until 20261030010000_ccp_c8pr_payment_record` and the gate `29 applied`. Its expected values are:
  - Q1 catalog: + 6 roles / + 17 scopes / + 50 role-scopes (25 / 211 / 1023 from production's 19 / 194 / 973);
  - Q7 `union_blocks = 30`;
  - Q8: 7 APPLYING backstops;
  - Q11: command-guard markers 3, alert types 12.

## 4. Suites (integration on, `--maxWorkers=3`)

| Suite | Files | Tests |
|---|---|---|
| libs/subscription (whole lib) | 68 / 68 | **1003 / 1003** |
| apps/platform-admin (whole app) | 45 / 46 | **995 / 996, 1 failed**; re-run in full: **996 / 996** (see §8.1) |
| libs/identity | 86 / 86 | **976 / 976** (scope pins 25 / 207 / 989) |
| libs/entitlement | 8 / 8 | **52 / 52** |
| libs/common | 13 / 13 | **85 / 85** |
| apps/sign-service | 41 / 41 | **504 / 504** |
| apps/auth-service | 29 / 29 | **394 / 394** |
| libs/auth-storage | 7 / 7 | **41 / 41** |
| apps/api, targeted CCP-touched + erasure + tenant-reset (69 files, 14 chunks) | 69 / 69 | **727 / 727** |
| apps/platform-web unit | 50 / 50 | **619 / 619** |
| mobile/sign (typecheck, lint, jest) | 28 suites | **253 / 253**; typecheck rc=0; lint rc=0 |

## 5. Targeted program proofs (run again on the gate head)

| Proof | Result |
|---|---|
| Full compensation chain 29 → 1 + re-apply; guard-union probes (16 action types); command-guard union probes; D3-U-1 alert-type union (12) | 4 files, **47 / 47** |
| PBD §7.2 C2-C8 re-run (C2-C8-1…3) | **3 / 3 passed** |
| D4 negative controls (incl. PAYMENT_RECORD), 3 runs | **15 / 15, 15 / 15, 15 / 15** |

## 6. Pact (every generated pact deleted first; 16 regenerated)

| Consumer | Tests |
|---|---|
| ats-web | 324 / 324 |
| auth-service-consumer | 6 / 6 |
| ingestion-consumer | 2 / 2 |
| intelligence-integration-consumer | 21 / 21 |
| intelligence-webhook-consumer | 2 / 2 |
| platform-governance-consumer | 13 / 13 |
| platform-web-consumer | 214 / 214 |
| portal-thin | 12 / 12 |
| prohibited-source-type | 1 / 1 |
| requisition-import-consumer | 1 / 1 |
| sign-consumer | 11 / 11 |
| sign-mobile | 21 / 21 |
| sign-source-consumer | 10 / 10 |
| sign-web-consumer | 6 / 6 |
| sign-workspace-consumer | 19 / 19 |

| Provider | Tests |
|---|---|
| verify-api | 1 / 1 |
| verify-sign | 1 / 1 |
| verify-platform-admin | 2 / 2 |
| verify-ti | 1 / 1 |
| verify (auth) | 2 / 2 |

## 7. Playwright (apps/platform-web)

| Project | Result |
|---|---|
| a11y (axe) | **213 passed** |
| keyboard | **39 passed** |
| responsive | **169 passed** |
| journeys | **39 passed** |
| visual (`--workers=1`) | 353 passed, 10 flaky, **2 failed**, 332 skipped |

**The 2 visual failures** are the two known Template Studio baseline exceptions (`doc/ccp/known-baseline-exceptions.md` §2):
- `studio-preview-zoom @900`: 61 px, 2 / 2 failing alone;
- `studio-compare-changes @1440`: 66 px, 2 / 2 failing alone.

Both are glyph edges only, and no CCP change touches the Template Studio sources: `git diff origin/main...HEAD` is empty for `apps/platform-web/src/document-templates`, `libs/document-templates-web` and `libs/fe-foundation`.

**The 10 flaky states** (passed on the project's configured retry) were each re-run **alone, serially, `--retries=0`, twice** (04:48–04:49 UTC, load 7–8):

| State | Attempts alone |
|---|---|
| `ccp-admins @1440` | pass, pass |
| `variables @1440` | pass, pass |
| `admins-domain-hint @1440` | pass, pass |
| `studio-drag @900` | pass, pass |
| `ccp-approvals-empty @1440` | pass, pass |
| `ccp-catalog-draft @1440` | pass, pass |
| `ccp-catalog-viewonly @1440` | pass, pass |
| `v12-renewals-loading @900` | pass, pass |
| `v12-recon @900` | pass, pass |
| `studio-properties @900` | **fail (39 px)**, then pass ×7 (8 attempts: 7 pass, 1 fail) |

9 of the 10 pass alone every time. `studio-properties @900` is **not called green**. It is a third Template Studio state (PLATFORM-UX-1, sources untouched by CCP) with an intermittent 39 px glyph-edge diff. It is recorded with the two known Template Studio exceptions. No baseline was re-captured.

## 8. Not green: recorded and investigated

1. **apps/platform-admin `sign-signup.integration.spec.ts` › "terms: an approved version must be accepted at start…"**
   - **The failure:** in the first full run, the second `POST /v1/signup/sign/start` (with `accept_terms: true`) answered 400 instead of 202.
   - **Re-runs:** the full suite re-run gave 996 / 996, and the file alone passed 30 / 30 in 7 consecutive runs. It could not be reproduced.
   - **Scope:** this is a Sign signup spec, not a CCP route. CCP touched only its A4 / A5 / A7 fixtures.
   - **Status:** the cause is not identified, so it stays on the watch list.
2. **Template Studio visual:** `studio-preview-zoom @900` and `studio-compare-changes @1440` fail consistently, and `studio-properties @900` intermittently (§7). PLATFORM-UX-1 owns them.

## 9. Divergences and decisions carried to the acceptance register

- **TD-MERGE-47 (W-1):** `basis: OPEN_SUBSCRIPTIONS_X_PINNED_LIST_PRICE` is kept (Lead decision, no contract churn); `recognized_revenue: false` was added.
- **TD-MERGE-52 (A9-FIX):** the distinct-human check counts every human reference an account was ever attested for, revoked ones included. That is stricter than instructed and fail-closed; it goes to the Architect.
- **R3-W gaps:** G-1 C, G-2 C, G-3 D (resolved by TD-MERGE-47), G-5 C.
- **UI-V12:** MBC-V12-1/2/3/6–14 are C (deferred under the scope freeze).
- **C8-PR:** G-C8PR-1 C (no B4 Payments panel); G-C8PR-2 resolved (runbook updated).
- **D6:** RX-4 (verify the ACTIVE policy's `refund_policy_sha256` against the LOCKED refund-policy sidecar before any refund release) and the §7.3 dark-state re-verification are checklist steps (`doc/ccp/program-completion-checklist.md`).
