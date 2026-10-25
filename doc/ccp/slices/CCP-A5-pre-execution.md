# CCP-A5 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-A5: PlanVersion + price pinning (D3) + v1 backfill |
| **Schedule** | PBD §5.1, row A5; PBD §6, §7 (A0-C7 no default reliance, A0-C15 migration authority); MP-A2 (`Aramo-E-Sign-Multi-Provider-Plan-Entitlements-Usage-Directive-Amendment-A2-CCP-Multi-Product-and-Versioning-v1_0-LOCKED.md`) N-1…N-4, N-10, N-15…N-19; Charter D3 (`Aramo-CCP-Program-Charter-v1_0-LOCKED.md:140`); Reconciliation Report §2 (`PlanVersion` design) and §3 slice S3 |
| **Baseline** | `wip/ccp-a5` cut from the program branch at `0294c905` (A1, A2, A3, A4 merged). Clean tree at start (`git status --short`: empty). Prisma clients regenerated (`npm run prisma:generate`, exit 0). |
| **Drift since the previous slice** | `0294c905` is the A4 merge commit itself; the A4 acceptance record (`doc/ccp/slices/CCP-A4-acceptance.md`, incl. its post-merge TD-A4-10) describes this tree. No other change. |
| **Parallelism** | CCP-A9 and CCP-A10 run in parallel in separate worktrees. A5 takes migration timestamp **`20261025160000_ccp_a5_plan_version`** (lead instruction; A9 uses a later one). A5 touches no identity, role or platform-admin route surface. Expected merge points: `libs/subscription/prisma/schema.prisma` (A5 adds models and edits only `Plan` and `TenantSubscription` relation lines), `libs/subscription/src/index.ts` (A5 appends an export block), the explicit migration lists in two `apps/platform-admin` specs (A5 appends one line), and `doc/generated/repo-map.*`. |

## 1. Prerequisites

| Prerequisite (PBD A5 row) | Evidence | Status |
|---|---|---|
| A4 evidence recorded | `doc/ccp/slices/CCP-A4-acceptance.md` (product_key + composition_role in place; post-merge TD-A4-10; Architect acceptance of the base-composition design) | ✅ |
| D3 approved (A0 review C2) | Charter `:140` "D3 … APPROVED: moved into PlanVersion data, with an env-parity check during cutover … RULED (A0 review) … Slice CCP-A5. The provider price is pinned to the version."; MP-A2 §7 O-1 "RESOLVED" | ✅ |
| MP-A2 LOCKED | `Aramo/locked/…-Amendment-A2-CCP-Multi-Product-and-Versioning-v1_0-LOCKED.md` + `.sha256` sidecar present | ✅ |
| A3 action types present (A5 provides repository methods only) | `libs/subscription/src/lib/commercial/commercial-change-request.ts:33` (`'PLAN_VERSION_PUBLISH', // A5 / B2`), `:74` (requester `platform:catalog:draft`), A3 migration `20261025120000…/migration.sql:88` (`'PLAN_VERSION_PUBLISH', 'PLAN_RETIRE'`); chain Finance → Owner (`CCP-A3-acceptance.md:44`, decisions TD-A3-2) | ✅ |

## 2. Design (fixed before code)

### 2.1 New tables and the N-4 statement (MP-A2 N-3 (a)–(d))

| Table | (a) schema | (b) FK to parent authority | (c) never answers "which plan / allowance does T hold for P" on its own | (d) no second subscription / entitlement / ledger |
|---|---|---|---|---|
| `PlanVersion` (N-2 "a child of `Plan`") | `subscription` | `plan_id → Plan(id)` | It holds a plan's versioned content. The tenant's plan is resolved only through `TenantSubscription.plan_version_id` (N-3(c) "through `plan_version_id` once A5 lands"). | No open/closed state of any tenant; no usage. |
| `PlanVersionPrice` (N-2 "any price-version record that is a child of `PlanVersion`") | `subscription` | `plan_version_id → PlanVersion(id)` | Maps a provider price to one version; never to a tenant. | No tenant, no state, no usage. |
| `SubscriptionVersionPinEvent` (N-17 "record the change") | `subscription` | `subscription_id → TenantSubscription(id)` | Append-only **history** of `plan_version_id` changes. The current pin is the `TenantSubscription` column, never this table. | No open/closed state, no usage; never read to decide a limit. |

Evidence lines: `schema.prisma:30-72` (`Plan`), `:105-160` (`TenantSubscription`), both in `libs/subscription/prisma/schema.prisma`; the new models are added in the same file. N-4 is satisfied; no Lead ruling needed on table placement.

### 2.2 PlanVersion (N-15, N-16)

- Columns: `id`, `plan_id`, `version_number` (UNIQUE per plan), `status` (`DRAFT | PUBLISHED | RETIRED`, CHECK, **no default**), `content` JSONB, `content_checksum`, `note`, `created_by`, `created_at`, `published_at`, `retired_at`. A lifecycle CHECK ties the timestamps to the status.
- **Content (format 1)** = the commercial projection of the live rows, byte-for-byte: `plan` = every `Plan` column except `id`, `created_at` and the four operational catalog columns (`sellable`, `status`, `display_order`, `activation_note`); `allowances` (`PlanAllowance`), `allowance_windows` (`PlanAllowanceWindow`), `capacities` (`PlanCapacity`), `features` (`PlanFeature`), each as an array sorted by its key columns (byte order). The four operational columns stay live on `Plan` (they are catalog state, not terms; PLAN_RETIRE and sellability are their own governed acts). This covers N-15's list (allowances, capacities, features, list price, currency, interval, commitment, eligibility) plus the other term columns (reference price, support tier) and the plan identity (key, product_key, name, description, tenant_kind, sales_model).
- **Checksum** = SHA-256 hex of the canonical JSON (`canonicalJson`, `libs/subscription/src/lib/commercial/commercial-policy.ts:83`, keys sorted, no whitespace). The DB recomputes it: an `IMMUTABLE` SQL canonicalizer + `sha256()` back a CHECK `content_checksum = subscription.ccp_plan_version_checksum(content)`, so a row whose checksum does not match its content cannot exist. TS and SQL canonical forms are asserted equal in the slice spec.
- **Immutability trigger (N-16):** INSERT only as `DRAFT`; a DRAFT's content may change (CHECK keeps the checksum honest); `DRAFT → PUBLISHED`; `PUBLISHED → RETIRED` changing **only** `status` and `retired_at`; any other UPDATE of a PUBLISHED row (content, checksum, note, published_at, back to DRAFT) and **every** UPDATE of a RETIRED row are rejected; identity columns are immutable in every state; **DELETE is rejected in every state**. The content's `plan.key` / `plan.product_key` must equal the parent `Plan`'s.
- **One PUBLISHED version per plan** (partial unique index): the plan's *current* version. Publishing v2 retires v1 in the same transaction (repository); v1 subscribers stay on v1 (grandfathering).

### 2.3 Provider price pinned to the version (D3, N-17) — the price-version child

`PlanVersionPrice (id, plan_version_id, provider CHECK 'STRIPE', provider_price_ref, created_by, created_at)`; `UNIQUE (plan_version_id, provider)` (one pin per version per provider) and `UNIQUE (provider, provider_price_ref)` (a provider price belongs to exactly one version, so `planForPrice` is deterministic). UPDATE and DELETE rejected (immutable from INSERT); INSERT refused for a RETIRED version.

**Why a child, not a `PlanVersion` column:** the v1 backfill must publish v1 inside the migration, but the migration cannot see the operator's `STRIPE_PLAN_PRICES` (process env, not DB). N-16 forbids a later UPDATE of a published version's provider price reference. A column would therefore leave every v1 permanently unpriced. The PBD A5 row anticipates "any price-version child". The pin is written once and never changed. See TD-A5-2.

### 2.4 Cutover: how `STRIPE_PLAN_PRICES` maps to versions (D3 "env-parity check during cutover")

| Version state | Effective provider price (checkout) | `planForPrice` (webhook) |
|---|---|---|
| Current PUBLISHED version **pinned**, env absent or equal | the pin (**authority**) | price → that version (any status) |
| Current PUBLISHED version **pinned**, env **differs** | **none — fail closed** (`BILLING_UNAVAILABLE`, "provider price parity mismatch") | price → the pinned version (provider truth about the subscription) |
| Current PUBLISHED version **unpinned**, env entry for the plan key | env value (**cutover fallback**) | env price → that plan's current PUBLISHED version |
| neither | none (as today: `BILLING_UNAVAILABLE`) | none |

- No pin exists after the A5 migration (the migration cannot read env), so behaviour equals today's in every environment until a pin is recorded. Recording pins for v1 is a write (repository method `pinProviderPrice`), executed later as a governed act (A6 apply; a MIGRATION-kind change request), **not in A5**.
- **Parity check (read-only):** `checkProviderPriceParity` runs in a `READ ONLY` transaction and reports, per env entry and per pinned current version: `MATCH`, `ENV_FALLBACK` (unpinned; env is the cutover authority), `PINNED_ONLY`, and the failures `MISMATCH`, `UNKNOWN_PLAN`, `NO_PUBLISHED_VERSION`, `DUPLICATE_PRICE`. `strict` (post-cutover) also fails `ENV_FALLBACK`. Exposed as the command `npm run billing:price-parity` (exit 1 on failure). Not wired into application boot (no new boot-time DB dependency; boot-smoke trap).

### 2.5 `TenantSubscription.plan_version_id` (N-18) and re-pinning (N-17)

- ADD nullable → backfill every row (open and ended) to its plan's v1 → `SET NOT NULL`, **no default ever** (A0-C7 rule carried forward). Composite FK `(plan_version_id, plan_id) → PlanVersion(id, plan_id)`: the pin always belongs to the row's plan, so a bare `plan_id` re-point is impossible at the DB.
- Trigger: a new row, or a changed pin, must reference a **PUBLISHED** version (a grandfathered row may stay on a RETIRED one). A changed pin must carry a transaction-local reason (`aramo.subscription_pin_reason`, closed CHECK, v1 `PROVIDER_PLAN_CHANGE`) and the trigger itself writes the `SubscriptionVersionPinEvent` (from/to plan, from/to version, reason, provider price, time). An unattributed re-pin is refused, so no path can re-point a subscription without history.
- `planForPrice` (`subscription-lifecycle.service.ts:794-802`) returns `{ plan_id, plan_version_id, source: PIN | ENV }`. `updateRow` re-pins only when the resolved version differs and is PUBLISHED; an ENV resolution to the **same plan** keeps the row's version (env cannot tell versions apart; grandfathering). `openRow` pins the resolved version, else the checkout plan's current PUBLISHED version.

### 2.6 Effective terms resolve through the pin (N-3(c), N-18, N-19)

Allowance, window, capacity and the subscription's terms (features, list price, commitment, eligibility) are read from the subscription's **pinned version** content, verified against its checksum and parsed strictly (fail closed). The catalog and checkout read the plan's **current PUBLISHED** version. With v1 = live rows (checksum-proved) every result is unchanged; publishing a later version cannot change an existing subscriber's limits. See TD-A5-1 for the N-1 reading this rests on.

### 2.7 Publishing and retiring

Repository methods only (`PlanVersionRepository`: list, get (checksum-verified), current, createDraft, createDraftFromLive, updateDraft, publish (retires the predecessor), retire, pinProviderPrice). Not exposed over HTTP, not called by any route or job: they are applied by A6 from approved `PLAN_VERSION_PUBLISH` / `PLAN_RETIRE` change requests.

### 2.8 Returned shapes

`AccountView`, `SubscriptionView`, `CatalogPlanView`, `AllowanceStatus` and the Sign availability body gain no field (the A4 goldens prove byte equality). So no `pact/provider/src/verify-api.ts` registration, and OpenAPI is unchanged.

## 3. Mandatory tests (PBD A5 row + lead brief) → planned coverage

| Obligation | Planned test (`libs/subscription/src/tests/ccp-a5-plan-version.integration.spec.ts` unless noted) |
|---|---|
| N-19 v1 checksum equals a recomputation from the live rows | populated DB (A4 corpus) → A5; per plan: exactly one v1, PUBLISHED; DB checksum = TS recomputation from the live rows (independent projection) = SQL projection |
| `planForPrice` resolves a version | PIN and ENV resolutions through `applyProviderState` (open and update) |
| No subscriber's effective limits change | the A4 golden corpus replayed through the A5 code after A5 is applied over the populated DB; plus the two app goldens (api ATS, sign-service Sign gate) re-run across A4 + A5 |
| N-16 immutability trigger (UPDATE and DELETE) | every rejected mutation per status; price-version UPDATE/DELETE |
| Grandfathering | publish v2 with different limits: v1 subscriber unchanged (pin and limits), new subscriber gets v2 |
| Env-parity pass and fail | each status; strict mode; checkout fail-closed on mismatch; read-only proof |
| Provider-side plan change re-pins with recorded history | SELF_SERVICE row moved by the provider to another plan's price → re-pinned + one pin event; unattributed raw re-pin refused; bare `plan_id` re-point refused |
| Migration on a populated DB | as N-19 above; counts kept; every row pinned (open and ended) |
| Compensating migration | applies while only v1 exists (and A5 re-applies after it); refused once a later version, a price pin or a pin event exists |

## 4. Compensating migration (recorded; not shipped as a forward migration)

Held as `libs/subscription/src/tests/fixtures/ccp-a5-compensating.sql` and executed by the slice spec. It must be applied together with a code revert of A5 (the A5 code selects `plan_version_id`). Guarded: RAISE unless every version is a migration v1, no `PlanVersionPrice` row exists, no pin event exists, every subscription is still on its plan's v1, and every v1 still equals its live rows (no information would be lost). Then: drop the pin trigger, the pin-event table, the composite FK and `plan_version_id`, the price table, the version table and the four functions. Production execution is not authorized (PBD §7.5, A0-C15); the `_local_migrations` ledger row is removed by the operator in the same transaction.

## 5. Path:line re-verification (2026-10-25, `0294c905`)

| Cited by | `path:line` | Verified |
|---|---|---|
| MP-A2 §1.4 (price env-sourced) | `subscription-lifecycle.service.ts:386` at `78dbd6d3` (`this.prices().get(input.plan_key)`) | ✅ moved by A4 to **`:401`** (`const price = this.prices().get(input.plan_key);`) |
| MP-A2 §1.4 / N-17 (`planForPrice`) | `:764-772` at `78dbd6d3` | ✅ now **`:794-802`** (`/** A provider price → a sellable plan of the SAME product (CCP-A4), else null. */`) |
| MP-A2 N-17 (in-place re-point) | `:668-669`, `:686` at `78dbd6d3` | ✅ now **`:694`** (`const plan_id = (await this.planForPrice(…)) ?? row.plan_id;`) and **`:711`** (`plan_id,` in the update data) |
| env source | `subscription-lifecycle.service.ts:185-196` (`parsePlanPrices`), `:261-263` (`prices()` reads `STRIPE_PLAN_PRICES`), `:265-267` (`billingAvailable`) | ✅ |
| Readers re-pointed to the pin | `allowance.service.ts:109-129` (`activePlan`), `capacity.service.ts:45-54` (`limitOf`), `subscription-lifecycle.service.ts:273-317` (catalog), `:331-367` (account), `:400-405` (checkout), `:527-529` (portal), `:744-768` (openRow), `:810-828` (refreshEligibility) | ✅ |
| Subscription writers (must name `plan_version_id`) | `development-subscription.ts:41-53`, `free-personal-subscription.ts:52-65`, `subscription-lifecycle.service.ts:758-782`; raw: `pact/provider/src/verify-sign.ts:247-250`, `:521-524` | ✅ |
| Plan columns of N-15 exist | `schema.prisma:46-59` (`list_price_minor`, `currency`, `billing_interval`, `commitment_months`, `eligibility`, `support_tier`) | ✅ |
| Prod env carrier | `docker-compose.prod.yml:465-469` (`STRIPE_PLAN_PRICES` passthrough) | ✅ (unchanged; no new env var) |

Note: MP-A2 §1.4 line numbers are pinned to `78dbd6d3`; A4 shifted them. The content cited is unchanged.

## 6. Typed divergences known before code

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| **TD-A5-1** | Interpretation (instrument tension), flagged for the Architect | MP-A2 N-1 says `PlanAllowance` … `PlanFeature` "SHALL remain the sole allowance, capacity and feature authorities". N-15 puts allowances, capacities and features in `PlanVersion`, N-18 requires that a new version not change existing subscribers' limits, and N-3(c) routes the answer through `plan_version_id` once A5 lands. With the live rows keyed by `plan_id`, grandfathering is only possible if the effective terms resolve through the pin. A5 therefore reads terms from the pinned version, which v1 proves byte-equal to the live rows. The live rows stay the catalog definition (the v1 source and the drafting source), and PlanVersion is the N-2 extension of `Plan`, not a parallel table. No observable result changes in A5. | Recorded for Architect ratification at the program acceptance review. If ruled otherwise, the reader re-point is isolated in two helpers and reverts without schema change. |
| **TD-A5-2** | Design choice the row leaves open | The provider price lives in the price-version child `PlanVersionPrice`, not as a `PlanVersion` column (§2.3). A first pin may be added once to a PUBLISHED version (cutover); it is never changed or removed. | Recorded |
| **TD-A5-3** | Design choice (cutover) | Until a version is pinned, `STRIPE_PLAN_PRICES` remains the cutover fallback for the plan's current version; a pinned price wins; a pin/env disagreement fails checkout closed (§2.4). | Recorded |
| **TD-A5-4** | Content projection | The four operational `Plan` columns (`sellable`, `status`, `display_order`, `activation_note`) are not version content (§2.2). | Recorded |

## 7. Correction-1 trigger check (PBD §2.4)

No unanticipated architectural change (every new table is an N-2 extension satisfying N-3, §2.1), no new commercial or regulatory decision (no price, plan or product is created; no pin is recorded), no governing-contract amendment. TD-A5-1 is an interpretation of existing LOCKED text, recorded for ratification, not a new rule. Design approval is not production migration authority (A0-C15): nothing in this slice runs against production.

## 8. Addendum (2026-10-25, recorded during execution)

- **§2.2 array order corrected.** The content arrays keep the child rows' **stored order** (`ORDER BY ctid` in the SQL projection; the given order in `planVersionContentFromRows`), not key order. Reason: the first golden run showed that `account` and `catalog` present `features` in stored order (those reads never had an `ORDER BY`), so key order changed an observable result. Stored order keeps every result byte-identical. Recorded as TD-A5-5 in the acceptance record.
- **Dependency of A5 on `20261023100000_sign_personal_free`.** The projection reads `PlanAllowanceWindow`, which that migration creates. The two `apps/platform-admin` signup specs had skipped it in their explicit lists; they now list it before A4 (TD-A5-6). Production and `tools/db-sync-local.sh` apply every migration in timestamp order, so this changes nothing outside those specs.
