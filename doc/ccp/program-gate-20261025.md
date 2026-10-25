# CCP program gate — 2026-10-25

| | |
|---|---|
| **Branch** | `feat/ccp-commercial-control-plane` (local only; not pushed) |
| **Gated HEAD** | `8cae29e5` (Merge CCP-B3 onto B5-R `cc7804e9`) |
| **Host** | quiet (load 5–7, no other agent running); suites at `--maxWorkers=3` |
| **Postgres** | `pgvector/pgvector:pg17` (server 17.11) for every integration suite and the from-scratch apply |
| **Authority** | Lead instruction (merge train, program gate). Not authorized: push, PR, merge to main, production migration, deployment, live billing. |

Every count below is exact and was read from that run's own log.

## 1. Result table

| Area | Command | Result |
|---|---|---|
| CI-simulated build | `nx run-many -t build --skip-nx-cache` over subscription, entitlement, common, platform-admin, aramo-platform-web, sign-service, auth-service, api, aramo-pact-provider and the 14 consumer pact projects | pass: 8 projects with a build target and the 75 tasks they depend on |
| Lint | `nx run-many -t lint` on the same 23 projects | pass: 23 projects, 0 errors |
| `contract-parity:check` | | pass |
| `openapi:drift-check` | | pass |
| `orphan-scopes:check` | | pass |
| `env:passthrough-check` | | pass |
| `error-codes:check` | | pass |
| `tests:integration:check` | | pass |
| `repo-map:check` | | pass |
| Vocabulary | `bash scripts/verify-vocabulary.sh` (whole tree) | pass (exit 0; no exemption added) |
| libs/subscription | `ARAMO_RUN_INTEGRATION=1 vitest run --root libs/subscription` | 47 / 47 files, 733 / 733 tests |
| apps/platform-admin | `ARAMO_RUN_INTEGRATION=1 vitest run --root apps/platform-admin` | 38 / 38 files, 743 / 743 tests |
| apps/sign-service | `ARAMO_RUN_INTEGRATION=1 vitest run --root apps/sign-service` | 34 / 34 files, 368 / 368 tests |
| apps/auth-service | `ARAMO_RUN_INTEGRATION=1 vitest run --root apps/auth-service` | 27 / 27 files, 353 / 353 tests |
| libs/entitlement | `ARAMO_RUN_INTEGRATION=1 vitest run --root libs/entitlement` | 7 / 7 files, 47 / 47 tests |
| libs/common | `ARAMO_RUN_INTEGRATION=1 vitest run --root libs/common` | 13 / 13 files, 85 / 85 tests |
| apps/platform-web unit | `vitest run --root apps/platform-web` | 47 / 47 files, 540 / 540 tests |
| apps/platform-web e2e, all projects | `playwright test` (`PW_E2E_PORT=4420`) | 621 passed, 2 failed, 268 skipped (§3) |
| apps/api targeted specs | 49 spec files (§4) | 49 / 49 files, 522 / 522 tests |
| apps/api full suite (`nx run api`) | — | **CI-only, not run locally** (PO ruling 2026-10-16: CI runs it on push) |
| Pact consumers | every consumer, from empty `pact/pacts/` | 14 / 14 consumer projects pass (§5) |
| Pact providers | every verifier in `pact/provider/src/verify*.ts`, `ARAMO_RUN_PACT_PROVIDER=1` | 5 / 5 verifiers pass (§5) |
| Migrations from scratch | all lib migrations in global order on a fresh Postgres 17 | 331 / 331 applied, 0 errors; intelligence-core (own database) 4 / 4, 0 errors |

## 2. Re-runs and flakes

None. Every suite above passed on its first run in this gate.

## 3. platform-web e2e detail

| Project | Passed | Failed | Skipped |
|---|---|---|---|
| visual | 299 | 2 | 268 (`capture-reference.spec.ts`: runs only with `PW_CAPTURE_REFERENCE=1`) |
| a11y (axe) | 152 | 0 | 0 |
| keyboard | 33 | 0 | 0 |
| responsive | 137 | 0 | 0 |

The two visual failures predate CCP. They are PLATFORM-UX-1 Template Studio states that fail on every attempt, with glyph-edge differences only and no layout change:

| State | Difference |
|---|---|
| `studio-preview-zoom @900` | 61 px |
| `studio-compare-changes @1440` | 66 px |

No CCP slice touches the Template Studio. No reference image was re-captured, and `git status` shows no modified baseline.

## 4. Targeted apps/api specs

The 49 `apps/api/src/tests/**` spec files changed by the CCP program (`git diff origin/main...HEAD`): every spec touched by A1, A4, A5, A7 and A8; D1 and D3 changed no apps/api spec. Added to them: the erasure and tenant-reset specs (`s2-erasure-authorization-confinement.spec.ts`, `s2-erasure-integrity.integration.spec.ts`, `tr15-b2-erasure.integration.spec.ts`, `tenant-reset.integration.spec.ts`).

They ran in 5 chunks with `ARAMO_RUN_INTEGRATION=1 --maxWorkers=3`:

| Chunk | Files | Tests |
|---|---|---|
| 1 | 10 / 10 | 138 |
| 2 | 10 / 10 | 105 |
| 3 | 10 / 10 | 100 |
| 4 | 10 / 10 | 90 |
| 5 | 9 / 9 | 89 |
| **Total** | **49 / 49** | **522 / 522** |

## 5. Pact

The generated pacts were deleted first. All 14 consumer projects then wrote 14 pact files.

**Consumer projects (14).** Each row is the consumer project's own count (tests / files).

| Consumer project | Tests (files) | Pact file written |
|---|---|---|
| ats-web | 324 (46) | `ats-web-aramo-core.json` |
| auth-service-consumer | 6 (1) | `auth-service-consumer-aramo-auth-service.json` |
| ingestion-consumer | 2 (1) | `ingestion-consumer-aramo-core.json` |
| intelligence-integration-consumer | 21 (1) | `intelligence-integration-talent-intelligence-service.json` |
| intelligence-webhook-consumer | 2 (1) | `intelligence-webhook-aramo-core.json` |
| platform-governance-consumer | 13 (1) | `platform-governance-consumer-aramo-core.json` |
| platform-web-consumer | 168 (3) | `platform-web-platform-admin.json` |
| portal-thin | 12 (5) | `portal-thin-aramo-core.json` |
| prohibited-source-type | 1 (1) | `prohibited-source-type-aramo-core.json` |
| requisition-import-consumer | 1 (1) | `requisition-import-consumer-aramo-core.json` |
| sign-consumer | 11 (1) | `aramo-core-sign-service.json` |
| sign-source-consumer | 10 (3) | `sign-service-aramo-core.json` |
| sign-web-consumer | 6 (1) | `sign-web-sign-service.json` |
| sign-workspace-consumer | 13 (1) | `sign-workspace-sign-service.json` |

**Providers (5 verifiers).** "Consumers verified" is the number of pacts that verifier checked. It is a different number from the consumer count above (CLAUDE.md).

| Verifier | Provider | Consumers verified | Result |
|---|---|---|---|
| `verify-api.ts` | aramo-core | 8 (ats-web, ingestion-consumer, intelligence-webhook, platform-governance-consumer, portal-thin, prohibited-source-type, requisition-import-consumer, sign-service) | 1 / 1 pass |
| `verify-sign.ts` | sign-service | 3 (aramo-core, sign-web, sign-workspace) | 1 / 1 pass |
| `verify-platform-admin.ts` | platform-admin | 1 (platform-web) | 2 / 2 pass (incl. the coverage gate) |
| `verify-ti.ts` | talent-intelligence-service | 1 (intelligence-integration) | 1 / 1 pass |
| `verify.ts` | aramo-auth-service | 1 (auth-service-consumer) | 1 / 1 pass |

All 14 pact files were verified: 8 + 3 + 1 + 1 + 1 = 14.

## 6. Migration hygiene

**From scratch.** `pgvector/pgvector:pg17` (17.11). Every `libs/*/prisma/migrations/*/migration.sql` was applied whole-file in the global name order that `tools/db-sync-local.sh` uses, with intelligence-core on its own database. Main database: 331 / 331 applied, 0 errors. intelligence-core: 4 / 4 applied, 0 errors.

**Registration in `verify-api.ts`.** Only one CCP migration changes an apps/api returned shape: the A7 entitlement provenance and revoke migration. It is registered at `pact/provider/src/verify-api.ts:1134`, applied at `:3765`, and `verify-api` passes.

The other CCP migrations do not need registering:
- The A1 and A9 identity migrations add role and scope rows and an invariant trigger, but no returned-shape change.
- Every subscription migration is outside the apps/api provider schema. `verify-api` applies no subscription migration, and the CCP routes live on platform-admin, verified by `verify-platform-admin.ts`, which applies every subscription migration through `applyCcpA6Schema`.

### Every CCP migration, in apply order (21)

"Not deployed" applies to every row. "Compensation" points at the documented, not-shipped compensating SQL.

| # | Migration | Compensating SQL |
|---|---|---|
| 1 | `identity/20261024120000_ccp_a1_commercial_role_catalog` | `libs/identity/src/tests/fixtures/ccp-a1-compensating.sql` (`CCP-A1-acceptance.md` §9) |
| 2 | `subscription/20261024180000_ccp_a2_commercial_audit_policy` | `doc/ccp/slices/CCP-A2-acceptance.md` §7 (line 151) |
| 3 | `subscription/20261025120000_ccp_a3_change_request_approval` | `CCP-A3-acceptance.md` §9 (line 188) |
| 4 | `subscription/20261025140000_ccp_a4_product_dimension` | `libs/subscription/src/tests/fixtures/ccp-a4-compensating.sql` (CCP-A4-pre-execution §5) |
| 5 | `subscription/20261025160000_ccp_a5_plan_version` | `libs/subscription/src/tests/fixtures/ccp-a5-compensating.sql` (CCP-A5-pre-execution §4) |
| 6 | `identity/20261025180000_ccp_a9_platform_last_owner_invariant` | `CCP-A9-acceptance.md` §6 (line 142) |
| 7 | `subscription/20261025180100_ccp_a9_role_change_apply_bootstrap` | `CCP-A9-acceptance.md` §6 (line 142) |
| 8 | `subscription/20261025200000_ccp_a6_transactional_apply` | `CCP-A6-acceptance.md` (line 212) |
| 9 | `subscription/20261025220000_ccp_b2_catalog_apply` | `CCP-B2-backend-acceptance.md` (line 73) |
| 10 | `subscription/20261025240000_ccp_d1_usage_rollups` (edited in place by D1-R) | `libs/subscription/src/tests/fixtures/ccp-d1-compensating.sql` |
| 11 | `entitlement/20261026000000_ccp_a7_entitlement_revoke_provenance` | `CCP-A7-acceptance.md` §8 (line 93) |
| 12 | `subscription/20261026000100_ccp_a7_entitlement_revoke_apply` | `CCP-A7-acceptance.md` §8 (line 93) |
| 13 | `subscription/20261026010000_ccp_a8_support_extension_overlay` | `CCP-A8-acceptance.md` (line 149) |
| 14 | `subscription/20261026020000_ccp_c1_stripe_command_inbox` | `CCP-C1-acceptance.md` (line 145) |
| 15 | `subscription/20261026030000_ccp_b4_enterprise_contracts` | `CCP-B4-acceptance.md` §6 (line 94) |
| 16 | `subscription/20261026050000_ccp_a6r_apply_deadline` | `CCP-A6-acceptance.md` A6-R (line 360) |
| 17 | `subscription/20261026060000_ccp_c2_conversion` | `CCP-C2-acceptance.md` §8 (line 125) |
| 18 | `subscription/20261026090000_ccp_d3_operational_alerts` | `CCP-D3-acceptance.md` §6 (line 151) |
| 19 | `subscription/20261027000000_ccp_guard_union` (integrator-owned, TD-MERGE-GUARD-1) | `libs/subscription/src/tests/fixtures/ccp-guard-union-compensating.sql` (restores CCP-C2's body; `decisions.md` TD-MERGE-GUARD-1) |
| 20 | `subscription/20261027000100_ccp_constraint_union` (integrator-owned, TD-MERGE-CHECK-1) | `libs/subscription/src/tests/fixtures/ccp-constraint-union-compensating.sql` (`decisions.md` TD-MERGE-CHECK-1) |
| 21 | `subscription/20261027000200_ccp_b5r_policy_activate_apply` | `libs/subscription/src/tests/fixtures/ccp-b5r-compensating.sql` (`CCP-B5-acceptance.md` B5-R.5) |

A11 has no migration. Its backfill compensation is `libs/subscription/src/tests/fixtures/ccp-a11-compensating.sql` (CCP-A11-acceptance §6).

## 7. Unresolved

1. **Missing compensating SQL — closed after the gate.** The four migrations the gate found without compensating SQL now have it, recorded in the table above. All four were proven on a fresh Postgres 17 by `ccp-merge-train-compensation.integration.spec.ts` (4 / 4 tests):
   - each compensation is refused while dependent data exists;
   - the four compensate in reverse order with 0 errors;
   - the four migrations then re-apply with 0 errors.
2. **Template Studio visual failures.** The two PLATFORM-UX-1 failures (§3) predate CCP.
3. **Full apps/api suite.** CI-only by PO ruling; it was not run locally.
4. **Open Lead questions from the merge train.** Carried forward in `doc/ccp/decisions.md` "Merge train": TD-MERGE-10 (catalog evidence travels in the reason), TD-C2-9 (the conversion keeps its own usage rule), and the BOUNDED_EXCEPTION chain label. B5-R since made APPLY_EXPIRED apply to every type, which closes the earlier APPLY_EXPIRED coverage question.
