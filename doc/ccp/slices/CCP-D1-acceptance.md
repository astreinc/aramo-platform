# CCP-D1 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.4 D1 row (`:121`).

| | |
|---|---|
| **Slice** | CCP-D1: usage roll-ups + consumption analytics |
| **Branch / baseline** | `wip/ccp-d1` at `b4a3f5f0`. Built in parallel with A6, B1, B2 and B5. |
| **Pre-execution record** | `doc/ccp/slices/CCP-D1-pre-execution.md` (choices D1-C1…C11, addendum §6 D1-C4a) |
| **Local commit SHAs** | **pending (lead commits).** Nothing committed or pushed by the executor. |
| **HALT conditions hit** | **None.** Totals reconcile exactly (§2). No pricing, rating or money column was needed. No allowance decision reads a roll-up. No registry value beyond `sign`. |
| **UI** | **Not built.** Consumption analytics is not in the CCP-UI v1.0 design release (the handoff excludes revenue charts). **The D1 UI needs a new design release, as D2's does.** No design hashes pinned (no UI part executed). |

## 1. Commit map (proposed; SHAs pending, lead commits)

| # | Proposed commit | Files |
|---|---|---|
| D1-0 | `CCP-D1: pre-execution record` | `doc/ccp/slices/CCP-D1-pre-execution.md` (new) |
| D1-1 | `CCP-D1: usage metric registry, roll-up tables, ledger watermark triggers (migration, Prisma models)` | `libs/subscription/prisma/migrations/20261025240000_ccp_d1_usage_rollups/migration.sql` (new); `libs/subscription/prisma/schema.prisma` |
| D1-2 | `CCP-D1: watermark roll-up worker, period aggregation, reconciliation and read side` | `libs/subscription/src/lib/usage/usage-metrics.ts`, `usage-rollup.service.ts`, `libs/subscription/prisma/usage-rollup.ts` (new); `libs/subscription/src/index.ts`, `src/lib/subscription.module.ts`; `package.json` (`usage:rollup`) |
| D1-3 | `CCP-D1: USAGE_ROLLUP_NOT_RECONCILED error code` | `libs/common/src/lib/errors/error-codes.ts`, `aramo-error.ts`, `libs/common/src/tests/error-codes.spec.ts`, `openapi/common.yaml` |
| D1-4 | `CCP-D1: platform-admin usage read routes + opt-in worker; OpenAPI, manifest, orphan-scopes, env` | `apps/platform-admin/src/app/platform/platform-commercial-usage.controller.ts`, `dto/commercial-usage.dto.ts`, `usage-rollup-worker.service.ts` (new); `platform.module.ts`; `openapi/platform.yaml`; `ci/config/api-surface-manifest.json`; `ci/scripts/verify-orphan-scopes.ts`; `docker-compose.prod.yml`; `.env.example`; `.env.prod.example` |
| D1-5 | `CCP-D1: tests (reconciliation, idempotency, watermark, per-role routes, worker gating) + shared D1 helper` | `libs/subscription/src/tests/ccp-d1-usage-rollups.integration.spec.ts`, `fixtures/ccp-d1.ts`, `fixtures/ccp-d1-compensating.sql`, `support/ccp-d1-database.ts`; `apps/platform-admin/src/tests/ccp-d1-usage-authorization.spec.ts`, `ccp-d1-usage-routes.integration.spec.ts`, `ccp-d1-usage-rollup-worker.spec.ts` (all new) |
| D1-6 | `CCP-D1: platform-web consumer contracts + platform-admin provider states for the usage routes` | `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts`; `pact/provider/src/verify-platform-admin.ts` |
| D1-7 | `CCP-D1: acceptance evidence` + `CCP-D1: regenerate repo map` | `doc/ccp/slices/CCP-D1-acceptance.md` (new); `doc/generated/repo-map.{files,coupling,projects}.json` |

Totals: **16 new files, 20 modified files** (36 paths). **Unchanged:** every existing migration; `libs/metering` (still the write path only, `record-usage.ts:18`); `AllowanceService` and every allowance / entitlement / billing reader; `pact/provider/src/verify-api.ts` (no `/v1` returned shape changes: the new `AllowanceUsage.rollup_xid` column is `Unsupported("xid8")`, never selected by the client); `doc/ccp/decisions.md`.

## 2. Reconciliation output (the D1 row's evidence)

From `ccp-d1-usage-rollups.integration.spec.ts` REC-1/REC-2 (written by the spec to `D1_EVIDENCE_OUT`), on Postgres 17 over: the populated A4 Sign corpus (15 subscriptions; pre-D1 ledger rows with `rollup_xid` NULL), an **Astre-shaped MANUAL subscription** (included plan, anchor 2026-03-31, 3 HISTORICAL rows across 2 periods via `recordHistorical`, 3 consumed + 1 released + 1 held sends via the real `AllowanceService`), and one UNALIGNED bucket (a tenant with no subscription).

First run (`FULL`): `to_xid` `801`, **12 buckets recomputed, 630 ledger rows scanned, RECONCILED, 0 mismatches, 0 pending.**

| Measure | AllowanceUsage (ledger) | Roll-up | Equal |
|---|---|---|---|
| Buckets (tenant × period) | 12 | 12 | ✅ (12 compared, 0 pending, 0 mismatched) |
| CONSUMED | 623 | 623 | ✅ |
| CONSUMED, origin SEND | 620 | 620 | ✅ |
| CONSUMED, origin HISTORICAL | 3 | 3 | ✅ |
| RESERVED (counted toward the allowance) | 4 | 4 | ✅ |
| Raw events: Σ `metering.UsageEvent` `sign.envelope.sent` vs ledger CONSUMED SEND | 620 | 620 | ✅ (9 tenants, 0 mismatched) |

Per (tenant, period), the roll-up rows equal an independent SQL recomputation of the ledger byte for byte (`ledgerTotals` = `rollupTotals`), after the first run and after every later test step (IDEM, WM, RO, COMP). Selected rows (REC-3): T(2) 2026-10-15 = 79 and 2026-09-15 = 5 (no rollover); T(4) = 96 consumed + 3 overdue reservations, 2 RELEASED not counted; T(14) day clamp period 2026-09-30 → 2026-10-31; Astre 2026-09-30 = 3 consumed + 1 reserved, 2026-07-31 = 2 historical, 2026-06-30 = 1 historical, all on the included plan's pinned v1 (100 / month); T(6) unlimited (included `null`, `unlimited` true); the no-subscription tenant counted as UNALIGNED. REC-4: for the Astre current period, roll-up consumed + reserved = `AllowanceService.getStatus().used`.

## 3. Mandatory tests → outputs

`libs/subscription/src/tests/ccp-d1-usage-rollups.integration.spec.ts` — **23 tests, 23 passed** (193.56 s).

| Obligation | Test(s) | Result |
|---|---|---|
| Totals reconcile to `AllowanceUsage` (multi-tenant + Astre-shaped MANUAL) | REC-1…REC-4 | ✅ |
| Totals reconcile to the metering raw events | REC-2; RO-3 (an extra `UsageEvent` ⇒ NOT_RECONCILED, expected 85 / actual 84; restored ⇒ RECONCILED) | ✅ |
| Worker idempotent: re-run | IDEM-1: 0 buckets, 0 rows, derived rows and run ids unchanged | ✅ |
| Worker idempotent: overlapping windows | IDEM-2: rewound to xid 1 (4 buckets) twice → identical rows; a rescan above the watermark is refused | ✅ |
| Worker idempotent: rebuild, concurrency | IDEM-3 REBUILD (12 buckets) → identical rows; IDEM-4 three concurrent runs → ≥1 COMPLETED, the others BUSY / CONFLICT, run-log rows = completed runs, totals equal the ledger | ✅ |
| Watermark correctness | WM-1 write after a run → pending (stale, not compared), next run 1 bucket / 1 row; **WM-2 a transaction open during the run and committed after it is picked up next run** (watermark ≤ its xid); WM-3 back-dated historical row into an old period picked up (xid, not time); WM-4 a row moved to a later period (release + re-reserve) and a DELETE → vacated bucket recomputed and pruned; WM-5 period carries the version in force at its start across a re-pin | ✅ |
| Worker off by default | OFF-1 (NOT_RUN, no derived rows, analytics refused); `ccp-d1-usage-rollup-worker.spec.ts` D1-OFF-1…4 (unset / `0` / `true` / ` 1` ⇒ no interval; `1` ⇒ 1 h interval; shutdown clears; a failed run never throws; ticks never overlap) | ✅ |
| Read-only until reconciled | RO-1 tampered period row ⇒ NOT_RECONCILED (PERIOD + DAILY + ROLLUP_USAGE_EVENT), analytics refused; REBUILD recovers. RO-2 missing row ⇒ mismatch (actual null). RO-4 source scan: only `src/lib/usage/*` and the module name the D1 tables (no allowance / entitlement / billing / sign-service / api reader). REC-1 ledger fingerprint unchanged by the worker. | ✅ |
| Registry | REG-1 DB = code mirror, Sign constants pinned; no price/amount/rate/currency column in any D1 table. REG-2 product CHECK = `PRODUCT_KEYS`; namespace CHECK; UPDATE / DELETE rejected | ✅ |
| Run log append-only | RO-5 | ✅ |
| Compensating SQL | COMP-1: 0 tables / columns / functions / triggers left, ledger fingerprint unchanged, D1 re-applies and reconciles | ✅ |

**Per-role read routes** (`platform:subscription:read`; allowed platform_owner, finance_admin, commercial_ops, support_admin, read_only_auditor; refused catalog_manager, **super_admin**):

| Spec | Result |
|---|---|
| `apps/platform-admin/src/tests/ccp-d1-usage-authorization.spec.ts` (real JwtAuthGuard + RolesGuard, mocked service) | ✅ 21 tests: matrix pin; 5 allowed × 2 routes; 2 refused × 2 routes (403 `missing_scopes` [`platform:subscription:read`], service never reached); 401 no token; 403 tenant tier; 409 `USAGE_ROLLUP_NOT_RECONCILED` (NOT_RECONCILED and NOT_RUN); filters typed; 9 × 400; 400 `unknown_metric` |
| `apps/platform-admin/src/tests/ccp-d1-usage-routes.integration.spec.ts` (real guards + real service + real Postgres, `ARAMO_RUN_INTEGRATION=1`) | ✅ 3 tests: 7 roles before a run (allowed ⇒ NOT_RUN + 409; refused ⇒ 403); after a run every allowed role reads RECONCILED totals and both periods (no money field); tampered roll-up ⇒ 409 for all 5 allowed roles; REBUILD recovers |
| `ccp-d1-usage-rollup-worker.spec.ts` | ✅ 4 tests |

## 4. Pact (A10 coverage gate)

- **Consumer** (`platform-web` → `platform-admin`): `vitest run --root pact/consumers/platform-web-consumer` — **40 / 40** (was 32; +8 for D1: reconciliation allowed by read_only_auditor, refused for catalog_manager; periods allowed by finance_admin, 409 not-reconciled for commercial_ops; super_admin and tenant-tier refusals for both routes via `GATE_ROUTES`). Consumer-contract count: **40 interactions** in `platform-web-platform-admin.json`; CCP routes covered: **10** (8 + 2).
- **Provider** (`verify-platform-admin.ts`): schema moved to the shared `applyCcpD1Schema` (A3 + A4 + A5 + A9 + D1); usage tenant seeded; 2 new provider states (`usage roll-ups are reconciled` = REBUILD; `usage roll-ups do not reconcile` = REBUILD + tamper). Run 1: coverage gate **passed** (every `/platform/commercial` route incl. the 2 new ones has allowed + super_admin + tenant-tier interactions); **36 / 40 interactions verified, 4 failed** — the 4 D1 interactions were the last four verified, and the Docker daemon failed exactly then (state handler: "Server has closed the connection"; the next requests 401; `afterAll` timed out; every later `docker` call returns HTTP 500). Run 2 could not start ("Could not find a working container runtime strategy"). **Provider-verified count for the D1 interactions: NOT YET VERIFIED (environment).** Docker was not restarted (Lead ruling 2026-10-25: no Docker restart during active CCP builds). See TD-D1-9; the lead re-runs `ARAMO_RUN_PACT_PROVIDER=1 vitest run --root pact/provider src/verify-platform-admin.ts` once Docker is healthy.
- `pact/provider/src/verify-api.ts`: unchanged (no `/v1` returned shape changes).

## 5. Gates and tests run / not run

| Gate / suite | Result |
|---|---|
| `nx run-many -t build -p subscription common platform-admin --skip-nx-cache` | ✅ 3 projects + 27 dependency tasks |
| `nx run-many -t lint -p subscription common platform-admin aramo-pact-provider platform-web-consumer-pact` | ✅ 0 errors (warnings only, `no-non-null-assertion` in the new code, same as existing code) |
| `tsc --noEmit` pact provider / platform-web consumer | ✅ 0 errors each |
| Unit: `libs/subscription` | ✅ 8 files, 187 passed (12 integration files skipped without the flag) |
| Unit: `libs/common` (incl. `error-codes.spec.ts`) | ✅ 12 files, 83 passed |
| Unit: `apps/platform-admin` | ✅ 13 files, 350 passed |
| Integration (`ARAMO_RUN_INTEGRATION=1`): the D1 lib spec and the D1 route spec | ✅ 23 + 3 |
| `contract-parity:check` (temporary index, intent-to-add) | ✅ 679 live routes (677 governed), 510 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified |
| `openapi:drift-check` | ✅ ok (9 files) |
| `orphan-scopes:check` | ✅ ok (`platform:subscription:read` now literally enforced; its ACTIVE_RESERVED entry removed; 2 read reservations remain) |
| `env:passthrough-check` | ✅ 109 passthrough (was 107: `CCP_USAGE_ROLLUP_ENABLED`, `CCP_USAGE_ROLLUP_INTERVAL_MS`) + 3 required-interp + 2 guarded, all documented |
| `tests:integration:check` | ✅ 49 roots |
| `bash scripts/verify-vocabulary.sh` | ✅ Tier 1, Tier 2, Front-Door clean |
| `repo-map:generate` / `repo-map:check` (temporary index) | ✅ regenerated (+239 / −2 lines over 3 files); check ok. Re-run if the staged set differs. |
| **Not run (Docker daemon down, TD-D1-9):** the other subscription integration specs and the AppModule-booting specs that glob `libs/subscription/prisma/migrations` (they pick up the new `AllowanceUsage` triggers): `libs/subscription` integration suite (allowance, A4, A5, A9, lifecycle, personal-free…), `apps/sign-service` AppModule specs + `ccp-a4-ats-sign-consumption`, `apps/platform-admin` `personal-signup` / `sign-signup`, `apps/api` `ccp-a4-ats-sign-availability` / erasure / tenant-reset; the platform-admin Pact provider re-run. Risk: low — the triggers set one derived column / append one bookkeeping row and never refuse a write; the D1 spec exercises reserve / consume / release / re-reserve / historical / DELETE through the real `AllowanceService` with them in place. | — |
| **Not run (instructed / program level):** full `nx run api`; all-provider Pact regression. | — |

## 6. Recovery and rollback

- Disable: leave `CCP_USAGE_ROLLUP_ENABLED` unset (the default). Roll-ups are derived; analytics stay refused unless reconciled.
- Rebuild: `npm run usage:rollup -- --rebuild`; status only: `npm run usage:rollup -- --reconcile-only`.
- Code: revert D1-1…D1-6. Schema: `libs/subscription/src/tests/fixtures/ccp-d1-compensating.sql` (proved by COMP-1; ledger untouched).
- Production execution of the migration, the compensation, the CLI or the worker is **not authorized** (PBD §7.5, §12).

## 7. Typed divergences

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| TD-D1-1 | Design choice | Read scope `platform:subscription:read` (not `platform:billing:read`); identical holders under A1 §4.1. | Recorded (D1-C1) |
| TD-D1-2 | Design addition | Sixth derived table `UsageRollupVacatedBucket` + AFTER UPDATE/DELETE trigger, so a period move or a DELETE never leaves a stale bucket. | Pre-execution addendum §6 |
| TD-D1-3 | Ledger table touched (additive) | `AllowanceUsage` gains `rollup_xid xid8` (nullable, trigger-set) and two triggers. No allowance decision reads them; no returned shape changes. Lead may prefer a change-log table instead; reversible by the compensating SQL. | For Lead review |
| TD-D1-4 | Semantics | RELEASED rows are not rolled up (they never count toward an allowance and can move period). Counted: CONSUMED (SEND / HISTORICAL) and RESERVED. | Recorded (D1-C5) |
| TD-D1-5 | Semantics | Raw-event check is per tenant lifetime (`UsageEvent` has no send identity or period), plus period-level reconciliation against the ledger. HISTORICAL rows have no raw event by design. | Recorded (D1-C7) |
| TD-D1-6 | Semantics | A period carries the plan version in force at `period_start`; a mid-period re-pin is not split. | Recorded (D1-C6) |
| TD-D1-7 | Scale | The live reconciliation scans the ledger for the metric on every reconciliation / analytics read. Fine at current Sign volumes; a cached run-time status is the follow-up if it grows. | Residual risk |
| TD-D1-8 | Paging | `/usage/periods` returns `limit` (≤ 500) rows with `truncated`, no cursor. | Recorded |
| TD-D1-9 | Environment | Docker daemon failed during the Pact provider run (HTTP 500 on every API call afterwards); provider verification of the 4 D1 interactions and the migration-glob regression specs are not yet run. Docker not restarted (Lead ruling). | **Lead re-runs when Docker is healthy** |
| TD-D1-10 | Merge note | Expected conflicts with A6/B1/B2/B5: `schema.prisma`, `src/index.ts`, `subscription.module.ts`, `platform.module.ts`, error-code registry (4 files, appended at the end), `openapi/platform.yaml`, manifest, `verify-orphan-scopes.ts` (A6/B3 may also enforce `platform:subscription:read`), consumer pact + `verify-platform-admin.ts` (now on `applyCcpD1Schema`), compose/env files, `package.json`, repo map. | For the lead at merge |
| TD-D1-11 | Out of scope (recorded) | No UI; the D1 UI needs a design release (as D2). | Recorded |

## 8. Vocabulary result

`scripts/verify-vocabulary.sh`: Tier 1 clean, Tier 2 clean, Front-Door clean. No exemption allowlist touched.
