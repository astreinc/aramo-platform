# CCP-A4 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-A4: product dimension |
| **Schedule** | PBD §5.1, row A4; PBD §7.1 (A0-C7), §7.4 (A0-C17); MP-A2 (`Aramo-E-Sign-Multi-Provider-Plan-Entitlements-Usage-Directive-Amendment-A2-CCP-Multi-Product-and-Versioning-v1_0-LOCKED.md`) N-5…N-14 |
| **Baseline** | `wip/ccp-a4` cut from the program branch at `b0e59aa6` (A1 and A2 complete; A3 pre-execution record and the NC-5 ratification recorded). Clean tree. `origin/main` `78dbd6d3`. |
| **Parallelism** | CCP-A3 executes in parallel in a separate worktree. A4 depends on A1 only (PBD §4 row 4). A4 changes no A3 surface. The A4 migration takes timestamp `20261025140000` so it sorts after A3's migrations. Expected textual merge points with A3: `libs/subscription/prisma/schema.prisma` (A4 edits are confined to the `Plan` and `TenantSubscription` models) and the explicit migration lists in the integration specs (A4 appends one line). |

## 1. Prerequisites

| Prerequisite | Evidence | Status |
|---|---|---|
| A1 evidence recorded | `doc/ccp/slices/CCP-A1-acceptance.md` (on the program branch) | ✅ |
| MP-A2 LOCKED | `Aramo/locked/…-Amendment-A2-CCP-Multi-Product-and-Versioning-v1_0-LOCKED.md` with its `.sha256` sidecar | ✅ |
| C17 fresh, authoritative enumeration | §2 below | ✅ (no uncoverable site class) |
| Composition shape chosen (N-10 (a) or (b)) | §3 below: **(a)** | ✅ executor choice, recorded here as the schedule requires; see §8 for confirmation status |

## 2. C17 enumeration of product-blind subscription access (A0-C17, PBD §7.4)

### 2.1 Method

Run on `b0e59aa6`, 2026-10-25. Five passes; every hit is classified in §2.2–§2.4.

| Pass | What it covers | Command (repo root) |
|---|---|---|
| M1 Prisma delegates | every read or write of `TenantSubscription` and `Plan` through the subscription Prisma client | `git grep -n -E 'tenantSubscription\|\.plan\.(find\|create\|upsert\|update)' -- ':!doc/**' ':!*.md' ':!libs/subscription/prisma/generated/**'` |
| M2 Raw SQL | every SQL string naming either table, in `.ts`, `.sql` and `.sh` files, including `ON CONFLICT` arbiters | `git grep -n -E 'TenantSubscription\|"Plan"\|one_open_per_tenant' -- ':!doc/**' ':!*.md' ':!libs/subscription/prisma/generated/**'` |
| M3 Indirect callers | every caller of a `@aramo/subscription` operation that resolves or mutates a subscription (allowance, capacity, lifecycle, development and FREE opening) | `git grep -l '@aramo/subscription'`, then a per-file scan for the operation names; **completed by the type checker**: `product_key` becomes a required argument of the closed literal type `ProductKey`, so an unchanged call site cannot compile. The checker runs over `libs/subscription`, `apps/sign-service`, `apps/platform-admin`, `apps/api/src/document-signing`, the two `apps/api` specs that import the lib, and `pact/provider/src/verify-sign.ts`, specs included; new diagnostics against the baseline run are the residue. |
| M4 Migration dependencies | migrations that create or alter either table or the index; every spec or tool that lists or globs subscription migrations; frozen migration fixtures | `ls libs/subscription/prisma/migrations`; `git grep -l -E 'subscription/prisma/migrations\|migrationsOf\|20261023100000_sign_personal_free'`; `tools/db-sync-local.sh:270`; `deploy/migrate-prod.sh` |
| M5 Scripts and seeds | `deploy/`, `tools/`, `scripts/`, `libs/*/prisma/seed*.ts` | covered by M1/M2 (no path exclusion other than docs and generated code) |

### 2.2 Library code (`libs/subscription/src/lib`), 23 references in 5 files

| # | `path:line` | Access | Class | A4 re-point |
|---|---|---|---|---|
| 1 | `allowance.service.ts:105-108` | `findFirst({ tenant_id, ended_at: null })` + plan allowances (reserve, status) | **S** open-row selector | `product_key` + `composition_role: 'BASE'` filter; product from a required `ProductKey` argument, checked against the declared key→product mapping |
| 2 | `allowance.service.ts:298` | same, `recordHistorical` | **S** | same |
| 3 | `subscription-lifecycle.service.ts:313` | `currentRow` open row (account read) | **S** | same |
| 4 | `subscription-lifecycle.service.ts:315` | `currentRow` most recent row by tenant (display fallback) | **T** tenant-scoped, not open-only | `product_key` filter |
| 5 | `subscription-lifecycle.service.ts:368` | `sendingOwner` open SELF_SERVICE row | **S** | product + BASE filter |
| 6 | `subscription-lifecycle.service.ts:395` | `startCheckout` open row (ALREADY_SUBSCRIBED gate) | **S** | product + BASE filter; the checkout plan must belong to the product |
| 7 | `subscription-lifecycle.service.ts:480-483` | `ensureBillingAccount` prior row's billing account | **T** | `product_key` filter (the `TenantBillingAccount` mapping, read first, is per tenant and unchanged) |
| 8 | `subscription-lifecycle.service.ts:502-505` | `portal` most recent billed row | **T** | `product_key` filter |
| 9 | `subscription-lifecycle.service.ts:558-560` | `applyProviderState` row by provider subscription ref | **R** ref-identified | product equality check (a row of another product is IGNORED) |
| 10 | `subscription-lifecycle.service.ts:580-582` | same, inside the billing transaction | **R** | `product_key` filter |
| 11 | `subscription-lifecycle.service.ts:675-688` | `updateRow` update incl. `plan_id` re-point | **W** | `planForPrice` restricted to the row's product; the DB composite FK (N-7) refuses a cross-product plan |
| 12 | `subscription-lifecycle.service.ts:720` | `openRow` open row to end | **S** | product + BASE filter (the intent plan's product, equal to the webhook context) |
| 13 | `subscription-lifecycle.service.ts:727` | `openRow` end the open row | **W** by id | follows #12 |
| 14 | `subscription-lifecycle.service.ts:731-753` | `openRow` create | **C** create | explicit `product_key` and `composition_role` |
| 15 | `subscription-lifecycle.service.ts:781-784` | `refreshEligibility` cross-tenant open scan | **X** cross-tenant scan | `product_key` filter (required argument) |
| 16 | `subscription-lifecycle.service.ts:795` | per-row eligibility update | **W** by id | follows #15 |
| 17 | `subscription-lifecycle.service.ts:802-807` | `reconcile` cross-tenant open scan | **X** | `product_key` filter; the product is carried to the per-row sync |
| 18 | `capacity.service.ts:41-44` | `limitOf` open row + plan capacities | **S** | product + BASE filter; capacity key→product mapping checked |
| 19 | `development-subscription.ts:33` | open row (idempotency) | **S** | product + BASE filter |
| 20 | `development-subscription.ts:38-47` | create DEVELOPMENT row | **C** | explicit `product_key`, `composition_role`; the plan must belong to the product |
| 21 | `free-personal-subscription.ts:49` | open row (idempotency) | **S** | product + BASE filter |
| 22 | `free-personal-subscription.ts:55-65` | create FREE row | **C** | explicit `product_key`, `composition_role`; the plan must belong to the product |
| 23 | `free-personal-subscription.ts:68` | open row after a concurrent create | **S** | product + BASE filter |

Plan-side reads in the same files (product of a plan): `subscription-lifecycle.service.ts:266` (`catalog`), `:385` (checkout plan by key), `:511` (portal plan by the row's `plan_id`), `:719` (`openRow` plan by id), `:768` (`planForPrice` by key); `development-subscription.ts:35`; `free-personal-subscription.ts:51`. Each is re-pointed: the catalog and price lookups filter by product; the by-key and by-id lookups check the plan's product.

### 2.3 Raw SQL, tests and tooling

| # | `path:line` | Access | Class | A4 re-point |
|---|---|---|---|---|
| 24 | `pact/provider/src/verify-sign.ts:245-249` | raw INSERT, `ON CONFLICT (tenant_id) WHERE ended_at IS NULL DO NOTHING` (`:248`) | **A** raw arbiter | explicit `product_key`, `composition_role`; arbiter `(tenant_id, product_key) WHERE ended_at IS NULL AND composition_role = 'BASE'` |
| 25 | `pact/provider/src/verify-sign.ts:518-522` | same (`:521`) | **A** | same |
| 26 | `libs/subscription/src/tests/allowance.integration.spec.ts:169-174` | raw INSERT after the full chain; asserts the error names `one_open_per_tenant` | **I** raw test INSERT + index name | explicit columns; the expected index name becomes the new one |
| 27 | `libs/subscription/src/tests/commercial-catalog-a1.integration.spec.ts:285` | raw `Plan` INSERT after the chain | **I** | explicit `product_key` |
| 28 | `libs/subscription/src/tests/commercial-catalog-a1.integration.spec.ts:287` | raw `TenantSubscription` INSERT after the chain | **I** | explicit columns |
| 29 | `libs/subscription/src/tests/commercial-catalog-a1-upgrade.integration.spec.ts:64-67` | raw INSERT **before** A1 (upgrade replay) | **P** pre-A4 seed | none: it runs before the A4 migration, which then backfills it; A4 is appended to the replay |
| 30 | `libs/subscription/src/tests/personal-free.integration.spec.ts:171` | Prisma `tenantSubscription.create` after the chain | **I** | explicit fields (the compiler requires them) |
| 31 | `apps/sign-service/src/tests/personal-free.integration.spec.ts:481-483` | raw INSERT after the chain | **I** | explicit columns |
| 32 | `apps/sign-service/src/tests/sign-api.integration.spec.ts:116-118` | raw INSERT after the chain | **I** | explicit columns |
| — | read-only test SQL: `allowance.integration.spec.ts` (none other), `commercial-catalog-a1-upgrade…:87`, `:89`, `:99`; `commercial-catalog-a1…:190`; `personal-free.integration.spec.ts:86`, `:90`, `:97`, `:104`, `:117`; `subscription-lifecycle.integration.spec.ts:172`, `:195`, `:289`; `apps/sign-service/src/tests/personal-free.integration.spec.ts:236`, `:256`; `apps/platform-admin/src/tests/personal-signup.integration.spec.ts:332` | **Q** tenant-scoped test reads in single-product fixtures | none needed: every fixture tenant holds only `sign` rows, and the assertions count or read that tenant's rows. Recorded, not re-pointed. |

No hit in `deploy/`, `tools/`, `scripts/` or any seed file other than `libs/subscription/prisma/seed-development-subscription.ts:19` (indirect, §2.4).

### 2.4 Indirect callers (M3)

| # | `path:line` | Operation | Re-point |
|---|---|---|---|
| 33 | `apps/api/src/document-signing/signature-availability.service.ts:102` | `getStatus` (ATS RTR/Offer availability, in-process transport) | pass `SIGN_PRODUCT_KEY` |
| 34 | `apps/sign-service/src/app/integrations/sign-api.service.ts:64` | `getStatus` (Sign API availability, D-12) | same |
| 35 | `apps/sign-service/src/app/personal/personal-send.gate.ts:248` | `getStatus` | same |
| 36 | `apps/sign-service/src/app/personal/personal-send.gate.ts:210` | FREE `ensure` | same |
| 37 | `apps/sign-service/src/app/aramo-sign-allowance.gate.ts:74-108` | `resolveStale`, `reserve`, `consume` ×2, `release` (the Sign send gate; ATS RTR/Offer sends reach it) | `product_key` in the shared key |
| 38 | `apps/sign-service/src/app/billing/aramo-sign-storage.gate.ts:21`, `:33`, `:37` | capacity `reserve`, `release`, `reserve` | same |
| 39 | `apps/sign-service/src/app/billing/esign-billing.controller.ts:173`, `:196`, `:199`, `:225`, `:243`, `:267` | `catalog`, `account`, `sendingOwner`, `startCheckout`, `portal`, `handleEvent` | same |
| 40 | `apps/sign-service/src/app/billing/esign-billing-reconcile.worker.ts:43`, `:51` | `reconcile`, `refreshEligibility` | same |
| 41 | `apps/platform-admin/src/app/platform/platform-sign.controller.ts:39` | `account` (operator view) | same |
| 42 | `libs/subscription/prisma/seed-development-subscription.ts:19` | `openDevelopmentSubscription` | same |

Test callers of the same operations (`libs/subscription/src/tests/*`, `apps/sign-service/src/tests/*`, `apps/api/src/tests/signature-availability.spec.ts`) are enumerated by the type checker during the slice; their count goes into the acceptance record.

### 2.5 Migration dependencies (M4)

| Item | `path:line` | A4 effect |
|---|---|---|
| The index A4 replaces | `libs/subscription/prisma/migrations/20261018120000_init_subscription_allowance/migration.sql:41-43` | dropped after the new one is built |
| Migrations that alter either table | `20261019100000_subscription_lifecycle_billing` (lifecycle columns, `CheckoutIntent`), `20261019140000_sign_commercial_catalog_a1` (catalog columns, 4 plans), `20261023100000_sign_personal_free` (`source` CHECK, FREE CHECK) | all sort before `20261025140000`; none is edited |
| Seeded plans | 5 plans (`aramo-sign-included-v1`, `-free-personal-v1`, `-standard-business-v1`, `-standard-professional-v1`, `-enterprise-v1`), plus the legacy `aramo-sign-business-v1` on databases that applied the original `20261019100000` revision (`fixtures/20261019100000_subscription_lifecycle_billing.c7aab66b.sql`). All are `aramo-sign-*`. | all backfilled to `sign` |
| Explicit migration lists | `libs/subscription/src/tests/{allowance,subscription-lifecycle,commercial-catalog-a1,commercial-catalog-a1-upgrade,personal-free,commercial-audit-policy}.integration.spec.ts`; `apps/platform-admin/src/tests/{personal-signup,sign-signup}.integration.spec.ts` (8 lists) | A4 appended (the Prisma client now selects the new columns) |
| Directory globs | `pact/provider/src/verify-sign.ts:50-56`, `:595`; `apps/sign-service/src/tests/*.integration.spec.ts` (`migrationsOf`); `tools/db-sync-local.sh:58`; `deploy/migrate-prod.sh` | pick A4 up automatically |
| `pact/provider/src/verify-api.ts` | lists no subscription migration | unchanged: A4 changes no returned shape (§6) |
| How migrations are applied | `tools/db-sync-local.sh:270`: `psql … --single-transaction -f` | the file runs in one transaction, so `CREATE INDEX CONCURRENTLY` is not available (§4) |

### 2.6 Reconciliation

| Figure | Source | Reconciled |
|---|---|---|
| **12 selectors in 5 files** | MP-A2 §1.4 | Rows 1, 2, 3, 5, 6, 12, 15, 17, 18, 19, 21, 23 of §2.2: exactly the 12 product-blind open-row selectors (class S plus the two X scans) MP-A2 lists, at the same lines. ✅ |
| **2 raw `ON CONFLICT` arbiters** | MP-A2 §1.4 | Rows 24 and 25 (`verify-sign.ts:248`, `:521`). ✅ |
| **"23 call sites in 5 files"** | Program Plan §3 A4 | The 23 `tenantSubscription` delegate references in the same 5 library files (allowance 2, lifecycle 15, capacity 1, development 2, FREE 3), reads and writes alike: rows 1–23 of §2.2. The 12 selectors are a subset of the 23. ✅ |
| **"plus 2 raw test INSERTs"** | Program Plan §3 A4 | The two `verify-sign.ts` INSERTs (rows 24–25; the Pact verifier is test tooling). ✅ |
| Beyond both figures | this enumeration | 3 tenant-scoped non-open reads (T: rows 4, 7, 8), 2 ref-identified reads (R: 9, 10), 7 plan-side reads, 6 post-chain raw/Prisma test writes (rows 26–28, 30–32), 1 pre-A4 test seed (29), 10 indirect-caller groups with 23 call sites (rows 33–42), 8 explicit migration lists. All are coverable. |

**Result: no site class the slice cannot cover.** No HALT.

## 3. Composition shape (MP-A2 N-10): **(a), a composition-role column**

`TenantSubscription.composition_role TEXT NOT NULL`, `CHECK (composition_role IN ('BASE'))` in v1, no default. The N-9 index is restricted to it: `UNIQUE (tenant_id, product_key) WHERE ended_at IS NULL AND composition_role = 'BASE'`.

Why (a), not (b):
1. **The predicate names the base composition literally** (N-10: "MUST name the base composition explicitly"). Under (b) the base would be implied by a rule held in a comment.
2. **One subscription authority** (N-1, N-3(d)). A later add-on or usage package can be a `TenantSubscription` row with another role, admitted by an additive CHECK widening. It needs no re-keying of `product_key`, no change to the base uniqueness and no second subscription-like table. Under (b) each add-on kind would need a child table with its own lifecycle, which sits closer to the N-3(d) line.
3. **DB-enforced in v1.** The CHECK admits `BASE` only, so nothing but a base row can exist until a governed migration widens it. Packs stay deferred (N-20). Nothing in A4 implements an add-on.
4. **Cost.** It adds one column. Every write already changes for `product_key`, so the same writes set `composition_role`. Like `product_key`, it has no DB default, so a write that omits it fails.

## 4. Live-table plan for the index swap (N-9)

Migration `libs/subscription/prisma/migrations/20261025140000_ccp_a4_product_dimension/migration.sql`. It is applied in one transaction (`--single-transaction`, §2.5).

1. `SET LOCAL lock_timeout = '5s'`, so the migration fails fast instead of queueing behind a long transaction.
2. Record the pre-migration row counts of both tables in a temp table (N-8 evidence inside the transaction).
3. `ADD COLUMN product_key TEXT` (nullable) on `Plan` and `TenantSubscription`, and `composition_role TEXT` on `TenantSubscription`.
4. **Deterministic backfill (N-8):** `UPDATE … SET product_key = 'sign'` on every `Plan` row and every `TenantSubscription` row, open and ended; `composition_role = 'BASE'` on every subscription row.
5. `SET NOT NULL` on all three columns. **No DB default is ever created**, not even a transitional one (stricter than N-11 permits).
6. Registry CHECKs (N-6): `Plan_product_key_registry_check` and `TenantSubscription_product_key_registry_check`, `CHECK (product_key IN ('sign'))`. Composition CHECK: `TenantSubscription_composition_role_check`.
7. Product equality (N-7): `UNIQUE (id, product_key)` on `Plan` (`Plan_id_product_key_key`), and the composite FK `TenantSubscription_plan_id_product_key_fkey (plan_id, product_key) REFERENCES Plan (id, product_key)`. The existing `plan_id` FK stays.
8. Guard: RAISE if the backfill left any row with another value or a NULL, if a count changed, or if any (tenant, product, BASE) has more than one open row.
9. **Build the new index first:** `CREATE UNIQUE INDEX "TenantSubscription_one_open_base_per_tenant_product" … WHERE ended_at IS NULL AND composition_role = 'BASE'`.
10. **Then drop the old one:** `DROP INDEX "TenantSubscription_one_open_per_tenant"`.

`CONCURRENTLY` cannot run inside the single-transaction apply. The table is small: one row per tenant subscription, one open row per tenant today. The `SHARE` lock of a plain build is held for the duration of an index build over that table, under the 5 s lock timeout. Production execution is **not** authorized (PBD §7.5, A0-C15). The plan is proved on a populated table in the slice tests.

## 5. Compensating migration (recorded; not shipped as a forward migration)

Reversible while every row is `sign` (N-9). It is held as the test fixture `libs/subscription/src/tests/fixtures/ccp-a4-compensating.sql`, which the slice tests execute. It must be applied together with a code revert of A4, because the A4 code selects the new columns.

```sql
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "subscription"."TenantSubscription" WHERE "product_key" <> 'sign' OR "composition_role" <> 'BASE')
     OR EXISTS (SELECT 1 FROM "subscription"."Plan" WHERE "product_key" <> 'sign') THEN
    RAISE EXCEPTION 'CCP-A4 compensation refused: a non-sign or non-BASE row exists';
  END IF;
  IF EXISTS (SELECT 1 FROM "subscription"."TenantSubscription" WHERE "ended_at" IS NULL GROUP BY "tenant_id" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'CCP-A4 compensation refused: a tenant has more than one open subscription';
  END IF;
END $$;
CREATE UNIQUE INDEX "TenantSubscription_one_open_per_tenant" ON "subscription"."TenantSubscription"("tenant_id") WHERE "ended_at" IS NULL;
DROP INDEX "subscription"."TenantSubscription_one_open_base_per_tenant_product";
ALTER TABLE "subscription"."TenantSubscription" DROP CONSTRAINT "TenantSubscription_plan_id_product_key_fkey";
ALTER TABLE "subscription"."Plan" DROP CONSTRAINT "Plan_id_product_key_key";
ALTER TABLE "subscription"."TenantSubscription" DROP COLUMN "composition_role", DROP COLUMN "product_key";
ALTER TABLE "subscription"."Plan" DROP COLUMN "product_key";
```

(Dropping the columns also drops their CHECKs.) The ledger row `20261025140000_ccp_a4_product_dimension` in `public._local_migrations` is removed in the same transaction by the operator. That is a PO-authorized production act, outside this directive.

## 6. Design points fixed before code

| Point | Decision |
|---|---|
| Registry form (N-6) | **CHECK constraints**, not a registry table. A table would be a new commercial table (N-4); a CHECK can only be widened by DDL in a migration. The code mirror `PRODUCT_KEYS = ['sign']` (`libs/subscription/src/lib/product-registry.ts`) is pinned to the DB CHECK text by a test. |
| Explicit product context (N-11) | Every operation listed in N-11 takes `product_key: ProductKey`, a **required** argument with no defaulting overload. `ProductKey` is the closed literal type `'sign'`, so a call that omits it, or passes an allowance key in its place, does not compile. At runtime an unregistered key throws. |
| Key→product mapping (N-11) | One declared namespace map: a metered key `sign.*` maps to `sign`. An allowance or capacity call whose key does not map to the given product throws, and an unmapped namespace throws (fail closed). |
| Webhook application | The Sign billing webhook passes `sign`. A provider subscription whose row or checkout plan belongs to another product is `IGNORED` and is not touched. `planForPrice` resolves only plans of the row's product. |
| Returned shapes | **Unchanged.** `AccountView`, `SubscriptionView`, `CatalogPlanView`, `AllowanceStatus` and the Sign API availability body gain no field (N-13: byte-identical Sign results). So `pact/provider/src/verify-api.ts` registration is not triggered, and OpenAPI is unchanged. |
| N-12 second key | `ccp_a4_isolation_test`. It is admitted only inside the test database: the test replaces the two registry CHECKs there. It appears in no migration, seed or production registry. A source-scan test proves it is absent from every migration and seed. A test proves the shipped CHECKs and the code registry reject it. |
| N-13 / N-13a before/after | **Golden capture on the baseline code.** Before any A4 code change, three corpus specs run on `b0e59aa6` code against the pre-A4 schema: Sign allowance, capacity and account semantics (`libs/subscription`); ATS RTR/Offer availability (`apps/api`); and ATS-triggered Sign consumption through the Sign send gate and the Sign API availability (`apps/sign-service`). They write golden JSON fixtures. After A4, the same corpus is seeded on the pre-A4 schema, the A4 migration is applied over it, and the same observation sequence must reproduce the goldens exactly. Between capture and comparison, only the call adapters (the added `product_key` argument) change. |
| Shared test helper (CLAUDE.md law) | The 8 explicit migration lists need the same one-line append. The A4 path and the N-12 registry-widening SQL come from one helper, `libs/subscription/src/tests/fixtures/ccp-a4.ts`, for the library specs. The two `platform-admin` lists hold root-relative strings and take the string. |
| N-4 (new commercial table) | Not triggered: A4 adds columns and constraints only. |

## 7. Path:line re-verification (2026-10-25, `b0e59aa6`)

| Cited by | `path:line` | Verified |
|---|---|---|
| MP-A2 §1.4 | `libs/subscription/prisma/migrations/20261018120000_init_subscription_allowance/migration.sql:41-43` ("-- One open subscription per tenant." / the index / `WHERE "ended_at" IS NULL`) | ✅ |
| MP-A2 §1.4 | `libs/subscription/prisma/schema.prisma:30-72` (`Plan`, no product column), `:105-148` (`TenantSubscription`), `:145` (the one-open comment) | ✅ |
| MP-A2 N-14 | `schema.prisma:167` (`@@unique([tenant_id, allowance_key, send_key])`) | ✅ (unchanged by A4) |
| MP-A2 §1.4 selectors | `allowance.service.ts:106`, `:298`; `subscription-lifecycle.service.ts:313`, `:368`, `:395`, `:720`, `:782`, `:803`; `capacity.service.ts:42`; `development-subscription.ts:33`; `free-personal-subscription.ts:49`, `:68` | ✅ all 12 |
| MP-A2 §1.4, PBD A4 row | `pact/provider/src/verify-sign.ts:248`, `:521` (`ON CONFLICT (tenant_id) WHERE ended_at IS NULL DO NOTHING`) | ✅ |
| MP-A2 §1.4 ATS | `apps/api/src/document-signing/signature-availability.service.ts:4` (import), `:102` (`getStatus(tenant_id, ESIGN_ENVELOPE_ALLOWANCE)`) | ✅ |
| MP-A2 N-13a | `doc/runbooks/RELEASE-esign-allowance.md:11` ("Without one, RTR and Offer sends stop for every tenant the moment this ships.") | ✅ |
| MP-A2 §1.4 price | `subscription-lifecycle.service.ts:386` (`this.prices().get(input.plan_key)`), `:764-772` (`planForPrice`), `:668-669`, `:686` (in-place `plan_id` re-point) | ✅ (A5 territory; A4 only restricts `planForPrice` to the product) |
| Key constants | `libs/subscription/src/index.ts:50` (`ESIGN_ENVELOPE_ALLOWANCE = 'sign.envelopes'`); `subscription-lifecycle.service.ts:93` (`STORAGE_CAPACITY_KEY = 'sign.storage_bytes'`) | ✅ |
| Apply mode | `tools/db-sync-local.sh:270` (`--single-transaction`) | ✅ |

## 8. Correction-1 trigger check (PBD §2.4) and confirmations

- **No correction-1 trigger.** No architectural change beyond MP-A2's authorized extension, no new commercial or regulatory decision, no governing-contract amendment. The registry stays `sign` only, and no plan is created.
- **Composition shape:** the A4 row and MP-A2 N-10 leave the choice to this record ("chosen in the pre-execution record"). They name no confirmer, so execution proceeds on (a). It is flagged as **TD-A4-1** for Lead/Architect visibility at the program acceptance review.
- **HALT conditions of the A4 row, checked before code:** the enumeration covers every site class (§2.6). No registry value other than `sign` is needed (the N-12 key is test-database-only, under the Architect's O-2 ruling). The remaining conditions (no Sign allowance result change, no historical caller selecting another product's row, any returned-shape change) are proved or disproved by the slice tests and reported in the acceptance record.

## 9. Addendum (2026-10-25, lead corrections received during execution)

1. **Migration timestamp.** CCP-A3 took `20261025120000` (`20261025120000_ccp_a3_change_request_approval`). The A4 migration is renamed **`20261025140000_ccp_a4_product_dimension`**, so it sorts strictly after A3. Every reference in this record and in the code was updated.
2. **`CommercialChangeRequest.product_key` (A3).** A3 adds this column with no default and an interim CHECK `product_key = 'sign'`. It backs the one-open-request-per-tenant×product index. The A4 migration carries a separate, guarded statement block that **replaces the interim CHECK with the governed registry CHECK** `CommercialChangeRequest_product_key_registry_check` (`product_key IN ('sign')`, N-6). The block is a no-op when the table or column does not exist. It drops every CHECK on that table whose definition references `product_key`; the constraint expected to be dropped is `CommercialChangeRequest_product_key_check`. The compensating SQL (§5, and fixture `ccp-a4-compensating.sql`) restores the interim CHECK. The lead verifies the real A3 constraint after the merge.
