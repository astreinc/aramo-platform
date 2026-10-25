# CCP-D1 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-D1: usage roll-ups + consumption analytics |
| **Schedule** | PBD §5.4 row D1 (`:121`): **In:** registry and watermark worker, read-only until totals reconcile (the architecture metering prerequisite). **Out:** usage-based pricing. **Tests:** totals reconcile to `AllowanceUsage`; worker idempotent. **Recovery:** disable the worker; roll-ups are derived. **HALT:** totals do not reconcile. **Evidence:** reconciliation output. Plus PBD §6 (common obligations) and §7 (§7.1 product keys, §7.5 migration authority). |
| **Other instruments** | Charter `Aramo-CCP-Program-Charter-v1_0-LOCKED.md` §4 (R3 release limitations), `:72` ("Phase D: metered/usage-rated items, only after rollups are proven"); architecture `doc/architecture/aramo-platform-console-enterprise-architecture.md:207-209` (metering prerequisite); CCP-A1 schedule §4.1 matrix (`Aramo-CCP-A1-Commercial-Roles-and-Scopes-Directive-v1_0-LOCKED.md:112`, `:118`); `doc/ccp/decisions.md` (TD-A5-1 ratified; T8 usage rule) |
| **Baseline** | `wip/ccp-d1` at `b4a3f5f0` (program branch: A1–A5, A9, A10 merged, plus the decision-register records). Clean tree at start (`git status --short`: empty). Prisma clients regenerated (`npm run prisma:generate`, exit 0). |
| **Drift since the previous slice** | `b4a3f5f0` is a decision-register commit on top of the A9 merge (`bd22fdd0`); the A4, A5, A9 and A10 acceptance records describe this tree. No source drift. |
| **Parallelism** | A6, B1, B2 and B5 run in parallel in other worktrees. D1 takes migration timestamp **`20261025240000_ccp_d1_usage_rollups`** (lead instruction). Expected merge points: `libs/subscription/prisma/schema.prisma` (D1 appends models and one `AllowanceUsage` line), `libs/subscription/src/index.ts` and `subscription.module.ts` (D1 appends), `apps/platform-admin/src/app/platform/platform.module.ts` (one controller + one provider), the error-code registry (D1 appends one code at the end), `openapi/platform.yaml`, `ci/config/api-surface-manifest.json`, `ci/scripts/verify-orphan-scopes.ts` (the `platform:subscription:read` reservation), the platform-web consumer pact and `verify-platform-admin.ts`, `docker-compose.prod.yml`, `.env.prod.example`, `.env.example`, `doc/generated/repo-map.*`. |

## 1. Prerequisites

| Prerequisite (PBD D1 row) | Evidence | Status |
|---|---|---|
| A4 evidence recorded | `doc/ccp/slices/CCP-A4-acceptance.md` (product_key on `Plan` and `TenantSubscription`; closed registry `sign`; `openBaseSubscription`) | ✅ |
| A5 evidence recorded | `doc/ccp/slices/CCP-A5-acceptance.md` (PlanVersion; `plan_version_id` pin; terms resolve through the pinned version, TD-A5-1 RATIFIED in `doc/ccp/decisions.md`) | ✅ |
| Architecture metering prerequisite | `aramo-platform-console-enterprise-architecture.md:209`: "a metric registry mapping event types to business metrics; a watermark-based daily rollup worker; period aggregation for invoice windows; a platform dashboard read API; and only then a provider sync adapter. Rollups stay read-only until totals reconcile to raw events." D1 delivers the first four; the provider sync adapter is OUT (usage-based pricing is out). | ✅ |

## 2. Substrate facts (re-verified at `b4a3f5f0`)

| Fact | `path:line` |
|---|---|
| Metering is write-only today | `libs/metering/src/lib/record-usage.ts:18` "Ruling 4: write path only. NO aggregation / read API / billing." |
| `UsageEvent` = (id, tenant_id, event_type, quantity, occurred_at); no send identity, no period | `libs/metering/prisma/schema.prisma` (model `UsageEvent`) |
| `AllowanceUsage` = one row per send identity, `state` RESERVED / CONSUMED / RELEASED, `origin` SEND / HISTORICAL, `period_start` fixed at reservation | `libs/subscription/prisma/schema.prisma:240` |
| A CONSUMED row writes exactly one `UsageEvent` in the same transaction | `libs/subscription/src/lib/allowance.service.ts:251` (RESERVED → CONSUMED), `:254` (`recordUsage(tx, …)` only when `n.count === 1`) |
| A HISTORICAL row is CONSUMED with no `UsageEvent` | `allowance.service.ts:329` (`origin: 'HISTORICAL'`, `createMany`, no `recordUsage`) |
| A RELEASED row can be re-reserved into a new period (it moves bucket) | `allowance.service.ts:231` |
| The Sign envelope allowance key and its event type | `libs/subscription/src/index.ts:62-63` (`sign.envelopes`, `sign.envelope.sent`) |
| Allowance "used" counts RESERVED + CONSUMED per (tenant, key, period_start) | `allowance.service.ts` `used()` |
| Product registry (`sign` only) and metered-key mapping | `libs/subscription/src/lib/product-registry.ts` (`PRODUCT_KEYS`, `productOfMeteredKey`) |
| No application code deletes `AllowanceUsage` rows | `grep -rn AllowanceUsage` over `apps libs scripts` (non-test): only the init, naming and Personal Free migrations |
| A1 matrix: `platform:subscription:read` and `platform:billing:read` held by PO, FA, CO, SA, RA; not CM, not SU | A1 schedule `:112`, `:118` |
| Both read scopes are ACTIVE_RESERVED today | `ci/scripts/verify-orphan-scopes.ts:98` (subscription:read), `:104` (billing:read) |

## 3. Design (fixed before code)

### 3.1 Choices this record makes (no PO or Architect confirmation needed; each recorded as a typed divergence in the acceptance record)

| ID | Choice | Basis |
|---|---|---|
| D1-C1 | **Read scope = `platform:subscription:read`.** Usage is allowance consumption under a subscription, not billing. `platform:billing:read` stays reserved for the C3/C4 billing status reads (its reservation text). Both scopes have the same holders, so the per-role outcome is identical either way. | A1 §4.1 `:112`, `:118`; `verify-orphan-scopes.ts:104` |
| D1-C2 | **Where the roll-ups live: the `subscription` schema, in `libs/subscription`.** The binding reconciliation source (`AllowanceUsage`) and the period/version authority (`TenantSubscription`, `PlanVersion`) are there, and `libs/subscription` already imports `@aramo/metering`. No new nx edge. `libs/metering` stays the write path only (`record-usage.ts:18` unchanged); the worker reads `metering."UsageEvent"` by raw SQL for the cross-check, as `recordUsage` writes it. | CLAUDE.md (no new cross-lib edge without 3-place wiring; none needed) |
| D1-C3 | **Metric registry = a governed DB table `UsageMetric`**, seeded by the D1 migration with one row (`sign.envelopes`, product `sign`, source `ALLOWANCE_USAGE`, cross-check event type `sign.envelope.sent`). Product CHECK = the A4 registry (`sign` only); UPDATE and DELETE rejected by trigger; widening is an additive governed migration. A code mirror `USAGE_METRICS` is pinned to the DB by test. No rating, price or unit price column (usage-based pricing is OUT). | PBD §7.1; Charter "no invented defaults" |
| D1-C4 | **Watermark = a Postgres transaction-id (xid8) watermark.** The D1 migration ADDs `AllowanceUsage.rollup_xid xid8` (nullable) and a `BEFORE INSERT OR UPDATE` trigger that sets it to `pg_current_xact_id()`. A run executes in one REPEATABLE READ transaction and processes every row with `rollup_xid >= watermark` (all rows on the first, FULL, run), then sets the watermark to `pg_snapshot_xmin(pg_current_snapshot())`. Every transaction below that xmin has finished, and every transaction at or above it is either visible to the run (and processed) or will carry an xid at or above the new watermark (and is processed next run). So late commits and back-dated rows (`recordHistorical`, a caller-supplied `at`) are never missed — which a timestamp watermark cannot guarantee. The column is never read by any allowance decision; no returned shape changes (the column is `Unsupported("xid8")` in Prisma, so the generated client never selects it). Rows written before the migration keep `NULL` and are covered by the first FULL run. | Architecture `:209` ("watermark-based"); the RELEASED → RESERVED re-reservation (`allowance.service.ts:231`) mutates rows, so a watermark over insert time alone would be wrong |
| D1-C5 | **Buckets are recomputed, never incremented.** A row past the watermark marks its bucket (tenant × metric × `period_start`) dirty; the worker recomputes the whole bucket from the source (daily rows by UTC day of `reserved_at`, then the period row as their sum) and replaces the derived rows. Re-runs, rewound watermarks and overlapping windows therefore converge to the same rows (idempotent). Counted states: CONSUMED (split SEND / HISTORICAL) and RESERVED. RELEASED rows are not rolled up: they never count toward an allowance, and a released row can move to another period (`:231`), which would make a per-period released count unreconcilable. | D1 row "worker idempotent" |
| D1-C6 | **Period alignment.** Each period row carries the tenant's BASE subscription for the product whose anchor produces that `period_start` and whose lifetime overlaps the period, `period_end` from `billingPeriodAt`, and the `plan_version_id` in force at `period_start` (from `SubscriptionVersionPinEvent` history, else the current pin), with that version's included quantity / unlimited flag (TD-A5-1: terms from the pinned version). A bucket that matches no subscription is kept and counted, marked `UNALIGNED` (never dropped, so totals still reconcile). | Brief; TD-A5-1 ruling |
| D1-C7 | **Reconciliation (exact).** (R1) For every bucket whose source rows are all below the watermark, the daily and period rows equal the source counts exactly (CONSUMED, CONSUMED-SEND, CONSUMED-HISTORICAL, RESERVED); a source bucket with no roll-up, or a roll-up with no source rows, is a mismatch. Buckets holding a row at or above the watermark are **pending** (written after the last run), reported, never compared. (R2) Per tenant, `UsageEvent` count of the metric's event type = `AllowanceUsage` CONSUMED rows of origin SEND (the two are written in one transaction, so they agree in every snapshot). (R3) For tenants with no pending bucket, Σ roll-up CONSUMED-SEND = that `UsageEvent` count. Status: `NOT_RUN` (no watermark), `RECONCILED` (zero mismatches) or `NOT_RECONCILED`. | D1 row tests and HALT; architecture `:209` "reconcile to raw events" |
| D1-C8 | **Read-only until reconciled.** `GET /platform/commercial/usage/reconciliation` always answers with the live status. `GET /platform/commercial/usage/periods` runs the live check first and **refuses** with 409 `USAGE_ROLLUP_NOT_RECONCILED` unless the status is `RECONCILED`; pending periods are returned flagged `stale: true`. No allowance, entitlement, billing or limit decision reads a roll-up (a source-scan test enforces it). | D1 row "read-only until totals reconcile" |
| D1-C9 | **Worker gating.** A platform-admin scheduler runs `UsageRollupService.run()` only when `CCP_USAGE_ROLLUP_ENABLED=1` (unset ⇒ off), interval `CCP_USAGE_ROLLUP_INTERVAL_MS` (default 1 hour, minimum 1 s). Documented in `.env.example`, `.env.prod.example`, passed through in `docker-compose.prod.yml` (platform-admin). A one-shot CLI (`npm run usage:rollup`, with `--reconcile-only` and `--rebuild`) is the operator path for evidence and recovery. Concurrency: a transaction-scoped try-lock; a second concurrent run returns `BUSY`, and a run whose snapshot predates a concurrent run's commit fails serialization on the watermark row (REPEATABLE READ) and writes nothing. | D1 row recovery "disable the worker" |
| D1-C10 | **Error code.** One new code, `USAGE_ROLLUP_NOT_RECONCILED` (HTTP 409), appended to the registry (`error-codes.ts`, `aramo-error.ts`, `openapi/common.yaml`, `error-codes.spec.ts`). | Closed error-code set |
| D1-C11 | **No UI.** Consumption analytics is not in the CCP-UI v1.0 design release (`doc/ccp/design-inputs.md`; the handoff excludes revenue charts). D1 ships the backend and its contracts only; **the D1 UI needs a new design release**, as D2's does. No design hashes are pinned because no UI part executes. | PBD §2.5; brief |

### 3.2 New tables (all `subscription` schema; derived data except the registry)

| Table | Purpose | Mutability |
|---|---|---|
| `UsageMetric` | metric registry | INSERT by migration only; UPDATE / DELETE rejected |
| `UsageRollupDaily` | tenant × metric × `period_start` × UTC day counts | derived; replaced per bucket by the worker |
| `UsageRollupPeriod` | tenant × metric × `period_start` counts + subscription / version alignment | derived; replaced per bucket by the worker |
| `UsageRollupWatermark` | one row per metric: the xid8 watermark (as `bigint`), last run | derived |
| `UsageRollupRun` | one row per run: mode, xid window, buckets recomputed, reconciliation result | append-only (UPDATE / DELETE rejected) |

None holds a price, an amount, a currency or a rate; none is a second ledger (the ledger stays `AllowanceUsage`; everything here is recomputable from it).

### 3.3 Recovery and compensating migration
- Disable: unset `CCP_USAGE_ROLLUP_ENABLED` (or set `0`). Reads then report the last state; analytics stay refused unless reconciled.
- Rebuild: `npm run usage:rollup -- --rebuild` deletes every derived row and the watermark in one transaction and runs FULL.
- Compensating SQL (recorded; executed by the D1 spec only): drop the `AllowanceUsage` trigger and function, drop `rollup_xid`, drop the five tables and their functions. Refused by nothing: every dropped object is derived or registry-only, and the allowance ledger rows are untouched.
- Production execution of the migration or its compensation is **not authorized** (PBD §7.5, A0-C15).

## 4. HALT watch
- Totals do not reconcile (PBD D1 HALT) → HALT and report.
- Any need for a rating, price or usage-based pricing column → out of scope; HALT.
- Any allowance decision that would need to read a roll-up → HALT (read-only rule).
- Any need for a registry value other than `sign` → HALT (PBD §7.1).

## 5. Correction-1 triggers (§2.4)
None has arisen: no unanticipated architectural change (D1 implements the architecture's own metering prerequisite, `:209`), no new regulatory or commercial decision (no pricing), and no governing-contract amendment.

## 6. Addendum (during execution, before any commit)
- **D1-C4a — vacated-bucket log.** A row that LEAVES a bucket (a DELETE, or an UPDATE that changes tenant, allowance or `period_start`, e.g. a RELEASED row re-reserved into a later period, `allowance.service.ts:231`) is invisible to the `rollup_xid` scan of its old bucket, which would leave that bucket stale and unreconcilable. The D1 migration therefore adds a sixth derived table, `UsageRollupVacatedBucket`, written by an `AFTER UPDATE OR DELETE` trigger on `AllowanceUsage` (old bucket + `pg_current_xact_id()`), read by the worker as part of the dirty set and by the reconciliation as part of the pending set, and pruned by the worker below the new watermark. Typed divergence TD-D1-2.
