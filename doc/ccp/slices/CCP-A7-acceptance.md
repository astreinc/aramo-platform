# CCP-A7 — acceptance evidence (entitlement revoke + provenance + resurrection guard)

| | |
|---|---|
| **Slice** | CCP-A7 (PBD §5.1 row A7) |
| **Pre-execution** | `doc/ccp/slices/CCP-A7-pre-execution.md` (value list §2, recon §3, choices C-1…C-9) |
| **Baseline** | `wip/ccp-a7` at `078d4f78` |
| **Commit SHAs** | pending (lead commits) |
| **HALT** | none. No existing `granted_source` value renamed; no resurrection path (row A7 HALT conditions not triggered) |

## 1. What A7 delivers

- **D1 revoke.** `entitlement."TenantEntitlement"` gains `revoked_at`, `revoked_by`, `revoke_change_request_id` (ADD); a revoked row is kept and is not entitled. The governed revoke is `ENTITLEMENT_REVOKE`, applied by the A6 transactional apply (`revokeCapabilitiesInTx`, same transaction, billing lock, NC-5 re-check, fault-safe), Finance-only chain (TD-A3-2). Revocable: the product bundle minus `core` (`sign` only).
- **Provenance.** `granted_source` (closed CHECK: `MANUAL | PLAN | PROMOTION | MIGRATION` kept verbatim + `PROVISIONING`, `SIGNUP` added), `granted_by`, `change_request_id`. Commercial (`MANUAL`, `PLAN`, `PROMOTION`) exactly when a change request is recorded. Writers: governed `SUBSCRIPTION_OPEN`/`_CHANGE` → `PLAN`; governed `ENTITLEMENT_GRANT` → `MANUAL`; provisioning saga + seed reconcile → `PROVISIONING`; Sign / Personal signup → `SIGNUP` (Conv. C-20); pre-A7 rows backfilled `MIGRATION`.
- **Ledger.** `entitlement."TenantEntitlementEvent"`, append-only; AFTER trigger records `GRANTED`, `REVOKED`, `REGRANTED`, `REMOVED` for every writer (raw SQL included); the repository records `RESURRECTION_REFUSED`.
- **`skipDuplicates` → upsert.** One shared statement (`libs/entitlement/src/lib/entitlement-provenance.ts`): `INSERT … ON CONFLICT DO UPDATE … WHERE revoked_at IS NOT NULL AND EXCLUDED.change_request_id IS NOT NULL`. An active row is never re-stamped; only a governed grant clears a revoke.
- **Resurrection guard.** SQL (above) + BEFORE UPDATE/DELETE trigger (`ENABLE ALWAYS`): clearing a revoke needs a NEW change request and a `MANUAL`/`PLAN` source; a revoked row cannot be deleted; provenance is immutable otherwise. Seed reconcile reports `withheld_revoked`; seed-prod Gate 3 counts active rows only.
- **2 readers re-pointed** (`entitlement.repository.ts` `getCapabilities`, `listTenantIdsWithCapability`: `revoked_at: null`). Mechanical (same lib, no nx edge).
- **Intelligence sync.** The REPLACE list is the re-pointed R2, so a revoked tenant is deactivated in TI on the next REPLACE; the publisher's R1 gate stops the per-ingest UPSERT (comment updated in `intelligence-entitlement-sync.service.ts`).
- **Guard function.** Migration `20261026000100` keeps the `20261025200000` body verbatim (0 lines removed, 55 added) and adds only the CCP-A7 branch (transitions + attempt/`applied_at` rules for `ENTITLEMENT_REVOKE`, its APPLIED backstop, and an active-row block for the A6 APPLIED backstop) + a second deferred no-APPLYING-commit trigger. Mirrored in `canTransitionFor` (`isA7Applicable`); A9-U-4 updated.

## 2. Mandatory tests (row A7) and outputs

All results below are from real Postgres 17 testcontainers after the Docker daemon restart (re-run in full; outage-time runs discarded).

| Row A7 test | Test ID(s) | Output |
|---|---|---|
| Next request loses the product | A7-E-2 (`libs/entitlement/src/tests/ccp-a7-revoke-provenance.integration.spec.ts`) | Before the revoke `EntitlementGuard` with `@RequireCapability('sign')` admits; after it rejects `TENANT_CAPABILITY_NOT_ENTITLED` 403; `core` still admitted; `getCapabilities` = `['core']`; the row is kept (`revoked: true`, `revoke_change_request_id` = the request); ledger `core:GRANTED:SIGNUP, sign:GRANTED:SIGNUP, sign:REVOKED:SIGNUP` |
| Refresh denied | A7-AUTH-1 (`apps/auth-service/src/tests/ccp-a7-revoke-refresh.integration.spec.ts`) | The real `IdentityPrincipalDirectoryAdapter.resolveScopes` over the real `TenantEntitlementReader` → `EntitlementRepository`: `resolved` → governed revoke → `{ kind: 'denied', reason: 'consumer_not_entitled' }` → a `PROVISIONING` grant leaves it denied → governed `MANUAL` re-grant → `resolved` |
| In-flight signing completes | A7-REV-2 (`libs/subscription/src/tests/ccp-a7-entitlement-revoke.integration.spec.ts`) | A send reserved before the governed revoke is `consume`d after it → `CONSUMED`; `apps/sign-service/src/app/esign-http.controller.ts` (`@Controller('v1/sign/signing')`) contains none of `RequireCapability`, `EntitlementGuard`, `EntitlementRepository`, `TenantEntitlementReader`, `getCapabilities` |
| Re-grant clears the revoke | A7-REV-4, A7-E-7 | Governed `ENTITLEMENT_GRANT ['core','sign']` after a revoke: `capabilities_inserted ['sign']`; row `MANUAL` with the grant's request, `revoked: false`; ledger adds `sign:REGRANTED:MANUAL`; the guard admits again; a later re-grant reusing the same request id raises `entitlement_resurrection` |
| Seed does not resurrect | A7-E-4, A7-E-5, A7-U-1 | `PROVISIONING` and `SIGNUP` grants on a revoked `sign` → `withheld_revoked: ['sign']`, row stays revoked, ledger `RESURRECTION_REFUSED` ×2. Reconcile (run twice) over a revoked `ats`: `granted: []`, `withheld_revoked: ['ats']`, `final: ['core','portal']`; the literal seed-prod Gate 3 SQL (read from `deploy/seed-prod.sh`) returns 2 → `assert_count_eq … 3` fails closed |
| Migration registered in `verify-api.ts` | §3 | verify-api provider: 1 passed |

Further A7 coverage: A7-E-0 (helper lists every entitlement migration on disk), A7-E-1 (backfill `MIGRATION` + ledger), A7-E-3 (REPLACE list drops the revoked tenant, keeps the other), A7-E-6 (DB guard, ledger append-only, three CHECKs, `ENABLE ALWAYS` under `session_replication_role = replica`, active-row removal ledgered `REMOVED`), A7-E-8 (C-20: `SIGNUP` non-commercial; reconcile leaves it), A7-E-9 (migration replay changes no row and adds no event), A7-PROV-1 (A6 grants stamped `PLAN` / `MANUAL` with their request), A7-REV-1 (revoke apply: application `capabilities_revoked ['sign']`, `capabilities []`, audit `…ENTITLEMENT_REVOKED` then `…APPLIED`, subscription stays open, idempotent replay byte-identical), A7-REV-3 (`core` → `CAPABILITY_NOT_REVOCABLE`, `ats` → `CAPABILITY_NOT_IN_PRODUCT`, not held → `CAPABILITY_NOT_HELD`; each APPLY_FAILED with domain snapshot and entitlement rows unchanged), A7-FAULT-after_subscription_write / -after_entitlement_write / -before_applied (rollback leaves the row active and the ledger unchanged; retry APPLIED, attempt 2), A7-END-1 (`SUBSCRIPTION_END` does not revoke), A7-SM-DB (A7 guard branch), A7-SM-A6 (A6 backstop counts active rows only), A7-U-2…A7-U-5 (value list pinned to the CHECKs; C-20 classification; writer fails closed before SQL; the upsert's guarded UPDATE branch).

## 3. `verify-api.ts` registration

`pact/provider/src/verify-api.ts:1134` `ENTITLEMENT_CCP_A7_REVOKE_PROVENANCE_MIGRATION` (`libs/entitlement/prisma/migrations/20261026000000_ccp_a7_entitlement_revoke_provenance/migration.sql`), applied at `:3765` right after `ENTITLEMENT_INTELLIGENCE_CAPABILITY_MIGRATION`. `verify-platform-admin` and `verify-sign` walk every entitlement / subscription migration and pick both A7 migrations up without an edit.

## 4. Tests run

| Run | Result |
|---|---|
| `libs/entitlement` integration: A7 spec + reconcile spec | 2 files, 15 passed |
| `libs/subscription` integration: A7, A6 apply, A6 hold, A9 bootstrap/role-change, A3 change-request | 5 files, 95 passed |
| `apps/auth-service` A7 integration | 1 file, 1 passed |
| `apps/platform-admin`: the 6 hand-listed-DDL integration specs, the A6 apply-route spec, the invitation unit spec | 8 files, 179 passed |
| `apps/api` representative edited specs (one per edit form + an `ensureAtsEntitlement` caller): ats-batch1-gating, doclib-t2, comm-b5, requisition-bookmarks, examine-live-list, portal-refusal, settings-tenant-get | 7 files, 52 passed |
| `apps/sign-service` `sign-api.integration` (directory walk) | 1 file, 9 passed |
| Unit: entitlement / subscription / common / intelligence-integration / platform-admin / auth-service | 32 / 202 / 83 / 69 / 325 / 304 passed (integration files skipped without the flag) |
| Pact consumers (all 14) then providers `verify-api`, `verify-platform-admin`, `verify-sign` | all passed (1 / 2 / 1 tests). The first ats-web consumer run had 3 failures in suites A7 does not touch; a single-worker re-run passed 46 / 46 files |
| `nx run-many -t build` (entitlement, subscription, common, identity, intelligence-integration, platform-admin, auth-service, sign-service, api) `--skip-nx-cache` | 9 projects + 71 dependency tasks succeeded |
| ESLint on every changed / new `.ts` | 0 errors (after fixing one `no-fallthrough`), warnings pre-existing |
| `contract-parity:check` | 678 live routes (676 governed), 509 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified |
| `openapi:drift-check`, `orphan-scopes:check`, `env:passthrough-check`, `error-codes:check`, `tests:integration:check` | ok (no new env var, no new error code, 49 integration roots) |
| `deploy/seed-prod.test.sh` | 22 passed, 0 failed |
| `repo-map:generate` / `repo-map:check` | regenerated (3 files modified); ok, under a temporary `GIT_INDEX_FILE` with intent-to-add entries for the new paths (real index untouched) |
| `bash scripts/verify-vocabulary.sh` | exit 0; Tier 1, Tier 2, front-door clean; no exemption touched |

**Not run:** the other 36 of the 43 edited apps/api specs (same mechanical edit, one form each covered above); the full `nx run api` (instructed: no full run; required before the program push, PBD §8).

## 5. Typed divergences

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| TD-A7-1 | Recon count | "2 readers": the repository read surface is exactly 2 (`entitlement.repository.ts:26`, `:42`), both re-pointed mechanically. 3 raw-SQL readers also exist outside it: `deploy/seed-prod.sh:237` (re-pointed: active rows only), the A6 APPLIED backstop `20261025200000…/migration.sql:217` (immutable; an A7 active-row block added in the new guard migration), and the A6 test snapshot `support/ccp-a6.ts:134` (unchanged; test-only) | Recorded |
| TD-A7-2 | Guard function | Besides the `ENTITLEMENT_REVOKE` branch, the new function adds an active-row backstop for APPLIED A6 actions (the re-point of the A6 read). The A6 lines are verbatim; the addition is a separate CCP-A7 block | For the lead's union |
| TD-A7-3 | DB default | `granted_source` keeps the DB default `MIGRATION`. PBD §7.1 forbids default reliance only for `product_key`; 83 raw fixture `INSERT` sites name no source. Every application writer names its source, and the TS signature requires it | Recorded |
| TD-A7-4 | Ripple / shared helper | The repository now reads A7 columns, so every spec that applied only the entitlement init migration broke. Fixed by ONE shared helper `libs/common/src/lib/testing/entitlement-migrations.ts` (`ENTITLEMENT_MIGRATIONS`, `resolveEntitlementMigrations`, `ENTITLEMENT_PROVENANCE_MIGRATION`), consumed by 43 apps/api specs + `apps/api/src/tests/ats-entitlement.ts`, 6 platform-admin specs (they hand-list older DDL and append the splitter-split A7 migration) and the entitlement reconcile spec (now whole-file via `pg`). The A7 entitlement migration is splitter-safe (single-quoted one-line bodies), verified: 32 split statements, 0 failures | Recorded; merge hotspot |
| TD-A7-5 | Scope question | `SUBSCRIPTION_END` still does not revoke (Conv. C-20; A6 comment `commercial-apply.service.ts:446-447`). A governed end that must also remove access is followed by an `ENTITLEMENT_REVOKE`. Revoking `PLAN`-sourced capabilities automatically at end would be a new commercial rule | **Lead / PO to rule** if auto-revoke at end is wanted |
| TD-A7-6 | Scope | `core` is never revocable by a product request; `ats` / `portal` / `intelligence` are outside the only registered product bundle, so no governed path can revoke them in v1 (the PBD names no product for them) | Recorded |
| TD-A7-7 | Signature change | `grantCapabilitiesInTx` now requires `granted_source`, `granted_by`, `change_request_id`; `EntitlementRepository.grantCapabilities` requires `granted_source` and returns `EntitlementGrantOutcome`. Parallel slices (A8, C1) calling either will fail to compile until they name a source | Merge note for the lead |
| TD-A7-8 | Response shape | `CommercialChangeApplication.capabilities_revoked` ADDED (column, DTO, controller, `openapi/platform.yaml`; `action_type` enum gains `ENTITLEMENT_REVOKE`). Additive; consumer contracts unchanged; `verify-platform-admin` green | For CCP-A10 contracts if a revoke interaction is wanted |
| TD-A7-9 | Harness | The Docker daemon was hung during the run (HTTP 500). An interim check on a local Postgres 14 through a temporary, never-committed testcontainers shim was discarded; every result in §2 and §4 is from real containers after the restart | Recorded |
| TD-A7-10 | Merge hotspots | `commercial-apply.service.ts`, `commercial-change-request.ts` (A8/C1 also touch apply/transitions), `guard_commercial_change_request()`, `libs/subscription/prisma/schema.prisma`, `openapi/platform.yaml`, `libs/common/src/index.ts`, `pact/provider/src/verify-api.ts`, `doc/generated/repo-map.*` | Lead merges; regenerate the repo map after the merge |

## 6. Recovery / rollback

- **A revoke:** governed re-grant (`ENTITLEMENT_GRANT`, or a `SUBSCRIPTION_OPEN` / `_CHANGE` carrying the capability). Never the seed, signup or provisioning.
- **A failed apply:** `APPLY_FAILED` is retryable; no partial state (A7-FAULT-*).
- **Code revert:** readers and writers revert cleanly while no row is revoked; see §8 for the schema.

## 7. Byte-unchanged proofs

| File | SHA-256 | Note |
|---|---|---|
| `deploy/seed-prod.sh` | `5818a02cc0ec986358e14cad28ea665185e9dfa815250372696429bd40953b4d` | CHANGED by A7 (Gate 3 active rows only; authorized: "resurrection guard in seed-prod"). A9-SEED-1 still passes |
| `libs/identity/prisma/seed.ts` | `4962f95368e984e2f12709fadba6b02cc5e728353dbe9160d42a93ca2f477f4a` | unchanged (= A9 record) |
| `libs/identity/prisma/seed-platform-owner.ts` | `274e405f955e2fcadd9430b3d7568db2e42e894daae31e312fb756e257641234` | unchanged |
| `libs/identity/prisma/seed-astre.ts` | `69c3f2f889adab5b5cb797560a554bbcd2fd7801bd1a0f190171b1cd11a25b8a` | unchanged |

## 8. Compensating SQL (documented, not shipped; never run against production, A0-C15)

```sql
-- 1. subscription (reverse 20261026000100)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM subscription."CommercialChangeApplication" WHERE action_type = 'ENTITLEMENT_REVOKE')
     OR EXISTS (SELECT 1 FROM subscription."CommercialChangeRequest" WHERE action_type = 'ENTITLEMENT_REVOKE' AND state IN ('APPLYING','APPLIED','APPLY_FAILED')) THEN
    RAISE EXCEPTION 'CCP-A7 compensation refused: governed revokes exist';
  END IF;
END $$;
DROP TRIGGER "commercial_change_request_no_applying_commit_a7" ON subscription."CommercialChangeRequest";
-- re-run the CREATE OR REPLACE FUNCTION subscription.guard_commercial_change_request() block of
-- 20261025200000_ccp_a6_transactional_apply verbatim
ALTER TABLE subscription."CommercialChangeApplication"
  DROP CONSTRAINT "CommercialChangeApplication_revoke_check",
  DROP CONSTRAINT "CommercialChangeApplication_subscription_check",
  ADD CONSTRAINT "CommercialChangeApplication_subscription_check" CHECK (("action_type" = 'ENTITLEMENT_GRANT') = ("subscription_id" IS NULL)),
  DROP CONSTRAINT "CommercialChangeApplication_action_type_check",
  ADD CONSTRAINT "CommercialChangeApplication_action_type_check" CHECK ("action_type" IN ('SUBSCRIPTION_OPEN','SUBSCRIPTION_CHANGE','SUBSCRIPTION_END','ENTITLEMENT_GRANT')),
  DROP COLUMN "capabilities_revoked";

-- 2. entitlement (reverse 20261026000000)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM entitlement."TenantEntitlement" WHERE revoked_at IS NOT NULL OR granted_source IN ('MANUAL','PLAN','PROMOTION')) THEN
    RAISE EXCEPTION 'CCP-A7 compensation refused: revoked or commercially sourced rows exist';
  END IF;
END $$;
DROP TRIGGER "ccp_a7_tenant_entitlement_ledger" ON entitlement."TenantEntitlement";
DROP TRIGGER "ccp_a7_tenant_entitlement_guard" ON entitlement."TenantEntitlement";
DROP FUNCTION entitlement.ccp_a7_record_tenant_entitlement_event();
DROP FUNCTION entitlement.ccp_a7_guard_tenant_entitlement();
DROP TABLE entitlement."TenantEntitlementEvent";
DROP FUNCTION entitlement.ccp_a7_reject_entitlement_event_mutation();
DROP INDEX entitlement."TenantEntitlement_capability_active_idx";
ALTER TABLE entitlement."TenantEntitlement"
  DROP CONSTRAINT "TenantEntitlement_revoke_check",
  DROP CONSTRAINT "TenantEntitlement_commercial_source_check",
  DROP CONSTRAINT "TenantEntitlement_granted_source_check",
  DROP COLUMN "revoke_change_request_id", DROP COLUMN "revoked_by", DROP COLUMN "revoked_at",
  DROP COLUMN "change_request_id", DROP COLUMN "granted_by", DROP COLUMN "granted_source";
```

## 9. Commit map (lead commits; SHAs pending)

| # | Commit | Files |
|---|---|---|
| A7-1 | `CCP-A7: pre-execution record` | `doc/ccp/slices/CCP-A7-pre-execution.md` |
| A7-2 | `CCP-A7: entitlement provenance, governed revoke, ledger and resurrection guard (migration + schema)` | `libs/entitlement/prisma/migrations/20261026000000_ccp_a7_entitlement_revoke_provenance/migration.sql`, `libs/entitlement/prisma/schema.prisma` |
| A7-3 | `CCP-A7: provenance upsert, revoke in tx, 2 readers re-pointed, reconcile/seed no-resurrection` | `libs/entitlement/src/lib/{entitlement-provenance.ts,entitlement.repository.ts,grant-capabilities-in-tx.ts,reconcile-entitlements.ts}`, `libs/entitlement/src/index.ts`, `libs/entitlement/prisma/seed-entitlements.ts`, `deploy/seed-prod.sh`, `libs/intelligence-integration/src/lib/intelligence-entitlement-sync.service.ts` |
| A7-4 | `CCP-A7: non-commercial provenance at provisioning and signup (C-20)` | `apps/platform-admin/src/app/platform/platform-invitation.service.ts`, `apps/platform-admin/src/app/signup/{sign-signup,personal-signup}.service.ts`, `apps/platform-admin/src/tests/platform-invitation.service.spec.ts` |
| A7-5 | `CCP-A7: ENTITLEMENT_REVOKE apply (guard branch, application column, TS mirror, route shape)` | `libs/subscription/prisma/migrations/20261026000100_ccp_a7_entitlement_revoke_apply/migration.sql`, `libs/subscription/prisma/schema.prisma`, `libs/subscription/src/lib/commercial/{commercial-apply.service.ts,commercial-change-request.ts}`, `libs/subscription/src/tests/ccp-a9-role-change.spec.ts`, `apps/platform-admin/src/app/platform/{dto/commercial-change-application.dto.ts,platform-commercial-apply.controller.ts}`, `openapi/platform.yaml` |
| A7-6 | `CCP-A7: shared entitlement migration helper and spec re-point` | `libs/common/src/lib/testing/entitlement-migrations.ts`, `libs/common/src/index.ts`, the 43 `apps/api/src/tests/*` specs + `apps/api/src/tests/ats-entitlement.ts`, the 6 `apps/platform-admin/src/tests/*.integration.spec.ts`, `libs/entitlement/src/tests/entitlement-reconcile.integration.spec.ts` |
| A7-7 | `CCP-A7: register the migration in verify-api` | `pact/provider/src/verify-api.ts` |
| A7-8 | `CCP-A7: revoke, resurrection and provenance tests` | `libs/entitlement/src/tests/{ccp-a7-revoke-provenance.integration.spec.ts,ccp-a7-provenance.spec.ts,reconcile-entitlements.spec.ts}`, `libs/subscription/src/tests/ccp-a7-entitlement-revoke.integration.spec.ts`, `apps/auth-service/src/tests/ccp-a7-revoke-refresh.integration.spec.ts` |
| A7-9 | `CCP-A7: acceptance evidence` + `CCP-A7: regenerate repo map` | `doc/ccp/slices/CCP-A7-acceptance.md`; `doc/generated/repo-map.{coupling,files,projects}.json` |

## 10. Vocabulary result

`bash scripts/verify-vocabulary.sh`: exit 0; Tier 1, Tier 2 and front-door clean. No exemption added or touched.

## R1. Correction TD-A7-3: no `granted_source` default (Architect program acceptance disposition)

**Ruling (binding, `doc/ccp/decisions.md`, row TD-A7-3):** remove the `MIGRATION` default; provenance is explicit; fix the fixtures and verify every production write path first; no silent fallback. **Baseline:** `wip/ccp-r1` at `41a0e3b5`. Uncommitted (lead commits).

### R1.1 Schema change

- `20261026000000_ccp_a7_entitlement_revoke_provenance/migration.sql`, edited in place (undeployed; **TD-R1-1**). `ADD COLUMN … "granted_source" TEXT NOT NULL DEFAULT 'MIGRATION'` becomes four statements: `ADD COLUMN IF NOT EXISTS "granted_source" TEXT`, `UPDATE … SET "granted_source" = 'MIGRATION' WHERE "granted_source" IS NULL` (explicit backfill of the pre-A7 rows, which are history, not a default), `ALTER COLUMN … SET NOT NULL`, `ALTER COLUMN … DROP DEFAULT`. The `DROP DEFAULT` also clears the default from any database that applied the pre-R1 text. The statements remain replay-safe and splitter-safe. On replay, the `UPDATE` matches 0 rows, so no trigger fires.
- `libs/entitlement/prisma/schema.prisma`: `granted_source String` (`@default("MIGRATION")` removed).
- The result: `is_nullable = NO` and `column_default = NULL`. An INSERT that names no source fails with `23502 null value in column "granted_source"` (R1-E-1).

### R1.2 Write-path inventory (`entitlement."TenantEntitlement"`, Prisma + raw SQL, apps/ libs/ pact/ tools/ deploy/ scripts/)

**Production: exactly one INSERT statement.** `libs/entitlement/src/lib/entitlement-provenance.ts:101` (`upsertEntitlements`, `:88`) names `granted_source, granted_by, change_request_id`. Its value is validated against the closed list and the commercial-iff-governed rule before any SQL runs (`assertProvenance`). The source is required in both entry points:

| Entry point | Source type (required) | Callers (`path:line` → source) |
|---|---|---|
| `EntitlementRepository.grantCapabilities` `libs/entitlement/src/lib/entitlement.repository.ts:58` | `UngovernedGrantSource` | `apps/platform-admin/src/app/signup/personal-signup.service.ts:490`, `:549`, `:580` → `SIGNUP`; `apps/platform-admin/src/app/signup/sign-signup.service.ts:391` → `SIGNUP`; `apps/platform-admin/src/app/platform/platform-invitation.service.ts:405` (`:408`) → `PROVISIONING`; `libs/entitlement/prisma/seed-entitlements.ts:63` (via `reconcile-entitlements.ts:89`; run by `deploy/seed-prod.sh`) → `PROVISIONING` |
| `grantCapabilitiesInTx` `libs/entitlement/src/lib/grant-capabilities-in-tx.ts:29` | `GovernedGrantSource` + `change_request_id` | `libs/subscription/src/lib/commercial/commercial-apply.service.ts:385` → `MANUAL` (`ENTITLEMENT_GRANT`) / `PLAN`; `libs/subscription/src/lib/commercial/commercial-conversion.ledger.ts:423` → `PLAN` |

Other writers:
- The A7 migration backfill (`UPDATE`, explicit `MIGRATION`).
- The A7 guard and ledger triggers. These are `UPDATE` paths only and never INSERT a row.
- The revoke `UPDATE`, `entitlement-provenance.ts:154`, sets no source.

There is no Prisma ORM write (`tenantEntitlement.create*` / `upsert` / `update*`), and `deploy/seed-prod.sh:240` only reads. These facts are pinned by `libs/entitlement/src/tests/ccp-r1-granted-source-scan.spec.ts`:
- R1-U-1: every INSERT names the source, apart from a closed exemption list with exact counts.
- R1-U-2: the production inventory is exactly `entitlement-provenance.ts`.
- R1-U-3: there is no ORM write.
- R1-U-4: `schema.prisma` has no `@default`.

The scan was shown to fail on a real omission during development: it flagged a comment line until that line was reworded.

### R1.3 Fixtures

Before R1, 88 INSERT sites named no source.

**84 fixture sites fixed, in 74 files.** Each now names `granted_source`. Sites by area:
- apps/api: 66 sites in 61 files. 65 are inline. `apps/api/src/tests/ats-entitlement.ts` now calls the shared helper.
- apps/sign-service: 6 sites in 6 files.
- libs/subscription: 4 sites in 4 files (`ccp-a6-apply`, `ccp-a8-support-extension`, `ccp-b3-subscription-read`, `ccp-c6-finance-report`).
- pact/provider: 8 sites in 3 files (`verify-api.ts` 4, `verify-platform-admin.ts` 1, `verify-sign.ts` 3).

Sources: 83 sites use `PROVISIONING`. 1 site uses `MIGRATION`: `ccp-b3-subscription-read.integration.spec.ts:177`, whose B3-I-7 asserts that a pre-existing migrated row reads `granted_source: 'MIGRATION'`. No fixture uses a commercial source, because the DB CHECK requires a change request for one.

**Exempt sites (closed list in the scan).** 4 of the 88 pre-R1 sites run against a pre-A7 schema, where the column does not exist yet. A fifth site is new in R1: the negative proof, which must omit the source. That makes 5 exempt sites in 4 files:
1. The immutable init migration seed `20260601120000_init_entitlement_model/migration.sql:32`.
2. The A7 integration spec's pre-A7 row, which the A7 backfill must stamp `MIGRATION`.
3. The A7 integration spec's R1-E-1 negative INSERT (new in R1).
4. `libs/subscription/src/tests/fixtures/ccp-a11-production-like.ts:150`: a production-like pre-CCP seed that the A7 backfill stamps `MIGRATION`.
5. `tools/sign-naming/naming.pg-integration.sh:93`: the old-world pre-rename tree.

**Shared fixture helper.** `libs/common/src/lib/testing/entitlement-migrations.ts` (exported from `@aramo/common`) adds the following:
- `FIXTURE_GRANTED_SOURCES` (`PROVISIONING | SIGNUP | MIGRATION`) and the `FixtureGrantedSource` type.
- `tenantEntitlementFixtureSql(granted_source)`, which rejects any other value.
- `seedTenantEntitlements(query, { tenant_id, capabilities, granted_source })`, which takes the source as a required argument.

### R1.4 Tests run (real Postgres 17 testcontainers, `ARAMO_RUN_INTEGRATION=1`, `--maxWorkers=2`)

| Run | Result |
|---|---|
| `libs/entitlement` (all, incl. new R1-E-1 + R1-U-1…4, updated A7-U-2) | 8 files, 52 passed |
| `libs/subscription` (all, incl. A6/A8/B3/C6 and A11) | 48 files, 737 passed |
| `apps/sign-service` (all) | 34 files, 368 passed |
| `apps/auth-service` (all) | 27 files, 353 passed |
| `apps/platform-admin` (all) | 38 files, 743 tests: 740 passed and 3 failed in the full run. The failures were `ccp-a3-commercial-change-request-authorization` ("socket hang up") and `ccp-d1-usage-routes` RI-2/RI-3 (120 s timeouts); neither file writes entitlements. Re-run alone: 2 files, 87 passed |
| `apps/api`: the 60 touched specs + the 7 `ensureAtsEntitlement` callers | 67 files, 655 passed |
| `deploy/seed-prod.test.sh` | 22 passed, 0 failed |
| Pact: `pact/pacts/` deleted, all 14 consumers regenerated (14 pact files), then providers `verify-api` / `verify-platform-admin` / `verify-sign` (`ARAMO_RUN_PACT_PROVIDER=1`) | consumers all passed; providers 1 / 2 / 1 passed |
| `contract-parity:check` | 708 live routes (706 governed), 539 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified |
| `openapi:drift-check`, `error-codes:check`, `orphan-scopes:check`, `env:passthrough-check`, `tests:integration:check` | ok (49 integration roots) |
| `bash scripts/verify-vocabulary.sh` | exit 0; Tier 1, Tier 2 and front-door clean; no exemption touched |
| `repo-map:generate` / `repo-map:check` | regenerated (3 files); ok. Staged in a temporary `GIT_INDEX_FILE` (a copy of the real index, plus `git add -A` of the touched trees); the real index is untouched (A7 practice) |
| `nx run-many -t build` (entitlement, common, subscription, platform-admin, auth-service, sign-service, api) `--skip-nx-cache` | 7 projects + 73 dependency tasks succeeded |
| `nx run-many -t lint` (same 7) | 0 errors (warnings pre-existing) |
| A11 golden `ccp-a11-dry-run.golden.txt` | unchanged; no regeneration needed (the A11 fixture keeps its pre-A7 shape, and the backfill still stamps `MIGRATION`) |

**Not run:** the full `nx run api` (PBD §8: before the program push), and the apps/api specs that write no entitlement row.

### R1.5 Compensating SQL

§8 is unchanged, because it drops `granted_source` outright. If only R1 has to be reversed, while A7 is kept, the statement is:

```sql
ALTER TABLE entitlement."TenantEntitlement" ALTER COLUMN "granted_source" SET DEFAULT 'MIGRATION';
```

That reversal is not recommended, because it reinstates the silent fallback that the ruling forbids. Design approval is not production migration authority (A0-C15).

### R1.6 Typed divergences

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| TD-R1-1 | Migration edited in place | `20261026000000…/migration.sql` was edited, not superseded by a new migration. It is undeployed, so the edit is authorized. `verify-api.ts` registration is unchanged (same path) | Recorded |
| TD-R1-2 | Count | A7 recorded 83 sites. The exact count at `41a0e3b5` is 88 INSERT sites without a source: 84 fixtures fixed plus 4 pre-A7 sites exempted (the 5th exemption is R1's own negative proof). The difference includes sites added by slices that landed after A7 (A8, B3, C6, A11 fixtures). The A7-time denominator is not reconstructible from the record | Recorded |
| TD-R1-3 | Helper use | Of the 84 sites, 1 (`ats-entitlement.ts`) moved to `seedTenantEntitlements`. 83 were kept inline, with `granted_source` added to the column list and to every VALUES tuple / SELECT. The inline form keeps per-site semantics, such as ON CONFLICT presence and multi-tenant VALUES lists; converting would change them. The scan enforces the source either way | For the lead |
| TD-R1-4 | Exemption | The A11 production-like fixture first received `MIGRATION`. That failed (`column "granted_source" … does not exist`), because the fixture seeds the pre-CCP schema. It was reverted and exempted | Recorded |
| TD-R1-5 | Flake | Under full-suite load, 3 platform-admin tests failed: 1 socket hang-up and 2 timeouts in files that do not write entitlements. All 3 passed on an isolated re-run | Recorded |
