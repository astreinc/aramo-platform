# CCP-A5 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.1 A5 row.

| | |
|---|---|
| **Slice** | CCP-A5: PlanVersion + price pinning (D3) + v1 backfill |
| **Branch / baseline** | `wip/ccp-a5`, cut from the program branch at `0294c905` (A1–A4 merged). Built in parallel with CCP-A9 and CCP-A10. |
| **Pre-execution record** | `doc/ccp/slices/CCP-A5-pre-execution.md` (design §2, N-4 statement §2.1, cutover rule §2.4, compensating SQL §4, path:line re-verification §5, addendum §8) |
| **Local commit SHAs** | **committed on `wip/ccp-a5` (merged with `--no-ff`, SHAs preserved): `b225c388` CCP-A5 A5-0: pre-execution record; `328e5ec5` CCP-A5 A5-1: PlanVersion, PlanVersionPrice, pin history, plan_version_id + v1 backfill; `f70ae761` CCP-A5 A5-2: plan-version content, repository, provider price pinning and the read-only parity check; `aaeb7885` CCP-A5 A5-3: terms resolve through the pinned version;  planForPrice → version;  re-pin with history; `900a98bc` CCP-A5 A5-4: shared A5 test helper;  re-point specs;  the A5 spec.** Nothing committed or pushed by the executor. |
| **HALT conditions hit** | **None.** Checksum mismatch: none (all 5 v1 checksums equal the recomputation, §2). Env-parity mismatch: none on the shipped data (no pin exists after the migration; the parity mismatch cases are test fixtures, §5). Path that edits a published version in place: none (the trigger refuses every one, §4; the repository has no such method). |

## 1. Commit map (proposed; SHAs pending, lead commits)

| # | Proposed commit | Files |
|---|---|---|
| A5-0 | `CCP-A5: pre-execution record` | `doc/ccp/slices/CCP-A5-pre-execution.md` (new) |
| A5-1 | `CCP-A5: PlanVersion, PlanVersionPrice, pin history, plan_version_id + v1 backfill (migration, Prisma models)` | `libs/subscription/prisma/migrations/20261025160000_ccp_a5_plan_version/migration.sql` (new); `libs/subscription/prisma/schema.prisma` |
| A5-2 | `CCP-A5: plan-version content, repository, provider price pinning and the read-only parity check` | `libs/subscription/src/lib/plan-version.ts`, `plan-version.repository.ts`, `billing/provider-price.ts`, `libs/subscription/prisma/check-provider-price-parity.ts` (new); `src/lib/subscription.module.ts`, `src/index.ts`; `package.json` (`billing:price-parity`) |
| A5-3 | `CCP-A5: terms resolve through the pinned version; planForPrice → version; re-pin with history` | `libs/subscription/src/lib/allowance.service.ts`, `capacity.service.ts`, `development-subscription.ts`, `free-personal-subscription.ts`, `billing/subscription-lifecycle.service.ts`; `pact/provider/src/verify-sign.ts` |
| A5-4 | `CCP-A5: shared A5 test helper; re-point specs; the A5 spec` | `libs/subscription/src/tests/fixtures/ccp-a5.ts`, `fixtures/ccp-a5-compensating.sql`, `ccp-a5-plan-version.integration.spec.ts` (new); `libs/subscription/src/tests/{allowance,ccp-a4-product-dimension,ccp-a4-sign-equality,commercial-audit-policy,commercial-catalog-a1,commercial-catalog-a1-upgrade,personal-free,subscription-lifecycle}.integration.spec.ts`; `apps/api/src/tests/ccp-a4-ats-sign-availability.integration.spec.ts`; `apps/sign-service/src/tests/{ccp-a4-ats-sign-consumption,personal-free,sign-api}.integration.spec.ts`; `apps/platform-admin/src/tests/{personal-signup,sign-signup}.integration.spec.ts` |
| A5-5 | `CCP-A5: acceptance evidence` + `CCP-A5: regenerate repo map` | `doc/ccp/slices/CCP-A5-acceptance.md` (new); `doc/generated/repo-map.projects.json`, `doc/generated/repo-map.coupling.json` |

Totals: **10 new files, 26 modified files** (36 paths). **Unchanged:** every existing migration; `pact/provider/src/verify-api.ts` (§6); `openapi/*`; every returned DTO; `apps/*` non-test code.

## 2. v1 checksums (N-19)

Recomputed from the live rows of a clean chain applied with `psql --single-transaction` (the runner's mode) on Postgres 17, and asserted equal to an independent TS projection of the live rows (plain SQL reads, `planVersionContentFromRows`, `canonicalJson`) in the A5 spec over the populated corpus:

| Plan key | v1 `content_checksum` (SHA-256) |
|---|---|
| `aramo-sign-enterprise-v1` | `051a982cdcc558268932efa0aaf3278d7d3a18904332645b25dff9e638670625` |
| `aramo-sign-free-personal-v1` | `32bf3be01fc36eaf85b5687a00be4a88cb4ab04659140bdb50240aea29b16607` |
| `aramo-sign-included-v1` | `6ec16b4a2d871fb0a1da7a890462e1b9a5721c68216d963df5acef700ad62bf8` |
| `aramo-sign-standard-business-v1` | `b4414302cd48c8306f0daac3ce2326b44724ee084378b9bb4d2c1779446408a8` |
| `aramo-sign-standard-professional-v1` | `77d0409d75c1fa839f384234ef8a859064b38fcc0915c85aa7d7d2ddeefd79d7` |

Populated-DB backfill (A4 Sign corpus, `ccp-a5-plan-version.integration.spec.ts`): **5** plans → **5** PUBLISHED v1 (`created_by = migration:20261025160000_ccp_a5_plan_version`); **14** subscriptions (13 open, 1 ended) → **14** pinned to their plan's v1; counts equal before and after and equal the A4 golden counts. Per plan, the stored content deep-equals the TS projection, the checksum equals the TS checksum, the SQL canonical text equals `canonicalJson`, and `ccp_plan_live_content` re-hashes to the same value. The migration's own guard RAISEs on any count change, any plan without exactly one PUBLISHED v1, any v1 ≠ live rows, or any subscription not on its plan's v1. The A1 upgrade replay (legacy plan `aramo-sign-business-v1` present) also passes through A5.

## 3. Limit-equality report (no subscriber's effective limits change)

| Spec | Golden (captured on `b0e59aa6`, pre-A4) | Observations | Result after A4 + A5 |
|---|---|---|---|
| `libs/subscription/src/tests/ccp-a5-plan-version.integration.spec.ts` (A5 migration over the populated corpus, A5 code) | `fixtures/ccp-a4-sign-equality.golden.json` | 15 tenants × 21 = 315 | equal ✅ |
| `libs/subscription/src/tests/ccp-a4-sign-equality.integration.spec.ts` (now applies A5 right after A4) | same | 315 | equal ✅ |
| `apps/api/src/tests/ccp-a4-ats-sign-availability.integration.spec.ts` (ATS RTR/Offer, + N-12) | `fixtures/ccp-a4-ats-sign-availability.golden.json` | 28 (+16 N-12) | equal ✅ |
| `apps/sign-service/src/tests/ccp-a4-ats-sign-consumption.integration.spec.ts` (Sign send gate, + N-12) | `fixtures/ccp-a4-ats-sign-consumption.golden.json` | 45 (+N-12 mirror) | equal ✅ |

The first golden run failed on `features` order (key order vs stored order); fixed by TD-A5-5, then equal.

## 4. Mandatory tests → outputs (`ccp-a5-plan-version.integration.spec.ts`, 26 tests, all passing)

| Obligation | Test(s) | Result |
|---|---|---|
| N-19 checksum = recomputation from live rows | "each v1 checksum equals an independent TS recomputation…" | ✅ |
| Migration on a populated DB | "row counts are kept…", "exactly one PUBLISHED v1 per plan…", "every subscription, open and ended, is pinned to its plan v1" | ✅ |
| No default reliance (A0-C7 rule carried) | "plan_version_id is NOT NULL with no default; a write that omits it fails"; source scan "every raw INSERT into TenantSubscription … names plan_version_id" (2 shipped INSERTs, 0 offenders) | ✅ |
| No subscriber's limits change | "golden: … equals the A4 baseline golden byte for byte" | ✅ |
| N-16 trigger rejects UPDATE and DELETE | created as DRAFT only; checksum CHECK; content names another plan → refused; DRAFT editable but never deleted; PUBLISHED: 7 mutations refused (content, content+checksum, note, published_at, back to DRAFT, identity, DELETE); repository `updateDraft` on PUBLISHED refused; RETIRED: 4 mutations refused; one PUBLISHED per plan | ✅ |
| Price versions immutable | UPDATE / DELETE refused; one pin per (version, provider); a provider price on one version only; no pin on a RETIRED version; idempotent re-pin of the same price; a different price refused | ✅ |
| Grandfathering | v1 subscriber (limit 10, storage 1000) unchanged byte-for-byte across publishing v2 (4 / 500); new subscriber pinned to v2 gets 4 / 500; live rows not edited by publishing; new pin to RETIRED or DRAFT refused by the DB; ENV-mapped price of the same plan never re-pins a v1 subscriber | ✅ |
| `planForPrice` resolves a version | ENV cutover (checkout uses the env price; activation pins the resolved version); PIN (a pinned price resolves to its version) | ✅ |
| Provider-side plan change re-pins with recorded history | business v1 → professional v1: plan + version re-pinned, 1 `SubscriptionVersionPinEvent` (reason `PROVIDER_PLAN_CHANGE`, price ref); repeat = no new event; professional v1 → business v2 via pin: 2nd event; unknown price keeps the pin; unattributed re-pin refused; bare `plan_id` re-point refused by the composite FK; history UPDATE/DELETE refused | ✅ |
| Env-parity pass and fail | pass: MATCH, ENV_FALLBACK (cutover), PINNED_ONLY; fail: MISMATCH, UNKNOWN_PLAN, NO_PUBLISHED_VERSION, DUPLICATE_PRICE (2 failures), env price pinned to another version, strict ENV_FALLBACK; checkout fails closed on pin/env disagreement (`BILLING_UNAVAILABLE`, "parity mismatch"), catalog `purchasable` false; the check writes nothing (row counts + version-table hash unchanged); the command exits 0 on parity and 1 on mismatch | ✅ |
| Compensating migration | applies while only v1 exists (0 tables, 0 columns, 0 `ccp_*` functions left; counts kept); A5 re-applies with identical version ids and checksums; refused once a price pin exists, and once a later version exists | ✅ |

## 5. Parity report (D3 cutover, shipped state)

After the A5 migration no `PlanVersionPrice` row exists (the migration cannot read operator env). Against any current `STRIPE_PLAN_PRICES`, every entry naming a sellable plan reports **ENV_FALLBACK** (non-strict: pass) and checkout behaves exactly as before A5. Recording the v1 pins (`PlanVersionRepository.pinProviderPrice`) is a governed act for A6 (MIGRATION-kind change request); after it, `npm run billing:price-parity -- --strict` must report MATCH for every entry. No production read was performed (none authorized).

## 6. Returned shapes, Pact and gates

- **No returned shape changed** (`AccountView`, `SubscriptionView`, `CatalogPlanView`, `AllowanceStatus`, Sign availability body): the goldens prove byte equality. No `pact/provider/src/verify-api.ts` registration needed; OpenAPI unchanged.
- **Pact `verify-sign`: run locally, green.** Consumer pacts regenerated: `sign-consumer` 11, `sign-web-consumer` 6, `sign-workspace-consumer` 11 = **28 consumer interactions passed**. Provider: `pact/provider/src/verify-sign.ts` verified the 3 pacts → sign-service: **1 provider test passed**. Reported separately as required.

| Gate | Result |
|---|---|
| `nx run-many -t build -p subscription sign-service platform-admin api --skip-nx-cache` | ✅ 4 projects + 75 dependency tasks |
| `nx run-many -t lint -p subscription sign-service platform-admin` | ✅ 0 errors (warnings only); ESLint on every changed/new `.ts` file: 0 errors |
| `contract-parity:check` | ✅ 677 live routes, 0 orphan, 0 unclassified |
| `openapi:drift-check` | ✅ ok (9 files) |
| `orphan-scopes:check` | ✅ ok |
| `env:passthrough-check` | ✅ (no new env var; `STRIPE_PLAN_PRICES` unchanged) |
| `repo-map:generate` / `repo-map:check` | ✅ regenerated; check ok |
| `scripts/verify-vocabulary.sh` | ✅ Tier 1, Tier 2, Front-Door clean |

## 7. Tests run and not run

| Suite | Result |
|---|---|
| `libs/subscription` unit + `ARAMO_RUN_INTEGRATION=1` (17 files, incl. the A5 spec) | ✅ 343 passed. One run hit a 60 s `afterAll` container-stop timeout in `allowance.integration.spec.ts` (all its tests had passed; host load); re-run: 11/11 passed |
| `apps/sign-service` unit (25 files) | ✅ 310 passed |
| `apps/sign-service` AppModule integration specs that glob the subscription migrations (`personal-free`, `recipient-inbox`, `sign-account`, `sign-api`, `sign-event-grant`, `sign-legal`, `sign-webhooks`) + `ccp-a4-ats-sign-consumption` | ✅ 8 files, 52 passed |
| `apps/platform-admin` unit (10 files) | ✅ 300 passed |
| `apps/platform-admin` `personal-signup` + `sign-signup` integration | ✅ 51 passed |
| `apps/api` `ccp-a4-ats-sign-availability`, `s2-erasure-integrity`, `tenant-reset`, `tr15-b2-erasure`, `portal-p4b-rtbf` (the last four apply every lib's migrations, incl. A5) | ✅ 5 files, 35 passed |
| `apps/api` `signature-availability`, `external-signature-providers`, `esignature-integration` unit | ✅ 39 passed |
| Pact `verify-sign` | ✅ (§6) |
| **Not run:** full `nx run api` (instructed; belongs to the lead at program acceptance); `pact:provider` for `verify.ts` / `verify-api.ts` / `verify-ti.ts` (no contract they verify reads the subscription schema); `apps/sign-web` (imports only the legal registry from `@aramo/subscription`). | — |

## 8. Recovery and rollback

- Code: revert A5-1…A5-4.
- Schema: the compensating SQL (pre-execution §4; `libs/subscription/src/tests/fixtures/ccp-a5-compensating.sql`), proved in §4. Applied with the code revert; refused unless only the migration v1 exists, no price pin and no pin event exist, every subscription is on its plan's v1, and every v1 still equals its live rows.
- Versions are additive: a bad later version is retired (PLAN_RETIRE), never edited or deleted.
- Production execution of the migration or its compensation is **not authorized** (PBD §7.5, A0-C15).

## 9. Typed divergences

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| **TD-A5-1** | Interpretation (instrument tension) | MP-A2 N-1 ("`PlanAllowance` … sole authorities") vs N-15 / N-18 / N-3(c): A5 reads effective terms from the subscription's **pinned version** (v1 proved = live rows). The live rows remain the catalog definition and the v1/drafting source. | **For Architect ratification** at the program acceptance review. Reversible in two helpers without schema change. |
| **TD-A5-2** | Design choice | The provider price lives in the price-version child `PlanVersionPrice`, not a `PlanVersion` column (v1 must publish in the migration, which cannot see env; N-16 forbids a later UPDATE). A first pin may be added once to a PUBLISHED version; never changed or removed. | Recorded |
| **TD-A5-3** | Design choice (cutover) | `STRIPE_PLAN_PRICES` stays a fallback for an unpinned current version; a pin wins; pin/env disagreement fails checkout closed. | Recorded |
| **TD-A5-4** | Content projection | `sellable`, `status`, `display_order`, `activation_note` stay live on `Plan` (operational catalog state); identity/display fields in the views (`key`, `name`, `description`, `tenant_kind`, `sales_model`) are read from `Plan`; terms from the version. | Recorded |
| **TD-A5-5** | Correction during execution | Content arrays keep the child rows' **stored order** (`ctid`), not key order: key order changed the presented `features` order (golden diff). | Pre-execution addendum §8 |
| **TD-A5-6** | Spec list change | `apps/platform-admin` signup specs now list `20261023100000_sign_personal_free` before A4 (A5's projection reads `PlanAllowanceWindow`). | Recorded |
| **TD-A5-7** | Signature change (internal) | `SubscriptionLifecycleService.billingAvailable()` is now `async` (true when configured and an env price **or** a version pin exists). No caller outside the lib. | Recorded |
| **TD-A5-8** | New fail-closed boundaries (unreachable with shipped data) | A plan with no PUBLISHED version: omitted from the catalog; checkout `PLAN_NOT_SELLABLE`; FREE opening `plan_missing`; DEVELOPMENT opening throws; activation `IGNORED` ("has no published version"). A provider price resolving to a RETIRED version never re-pins (kept, logged). | Recorded |
| **TD-A5-9** | Mechanism choice | The re-pin history is written by an `AFTER` trigger on `TenantSubscription`, attributed by the transaction-local setting `aramo.subscription_pin_reason` (+ `aramo.subscription_pin_price_ref`); an unattributed re-pin is refused. Reason CHECK v1 = `PROVIDER_PLAN_CHANGE`; A6 widens it additively for applied change requests. | For A6 |
| **TD-A5-10** | Merge note | Expected textual conflicts with A9/A10: `schema.prisma`, `src/index.ts`, `subscription.module.ts`, `package.json` scripts, `doc/generated/repo-map.*`. Specs that glob migrations will pick up A9's later migration automatically. | For the lead at merge |

## 10. Vocabulary result

`scripts/verify-vocabulary.sh`: Tier 1 clean, Tier 2 clean, Front-Door retirement clean. No exemption allowlist touched; A5 adds no Stripe wire vocabulary outside existing code.
