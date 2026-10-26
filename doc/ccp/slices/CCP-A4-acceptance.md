# CCP-A4 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.1 A4 row.

| | |
|---|---|
| **Slice** | CCP-A4, product dimension |
| **Branch / baseline** | `wip/ccp-a4`, cut from the program branch at `b0e59aa6`. Built in parallel with CCP-A3. The lead merges A4 onto the program branch after A3. |
| **Pre-execution record** | `doc/ccp/slices/CCP-A4-pre-execution.md` (C17 enumeration §2, composition shape §3, live-table plan §4, compensating SQL §5, path:line re-verification §7, addendum §9) |
| **Local commit SHAs** | committed on `wip/ccp-a4` (merged onto the program branch with `--no-ff`, preserving these SHAs): `7391001b` CCP-A4 A4-0: pre-execution record (C17 enumeration, composition shape, live-table plan); `085e1cf7` CCP-A4 A4-1: baseline N-13/N-13a goldens (captured pre-A4); `19af1d02` CCP-A4 A4-2: product_key + composition_role migration (registry CHECKs, composite FK, index swap) and Prisma models; `27bf11fd` CCP-A4 A4-3: closed product registry and explicit product context in libs/subscription; `f009bb09` CCP-A4 A4-4: re-point every caller to explicit Sign product context; `0044a50f` CCP-A4 A4-5: re-point specs;  shared A4 test helper;  product-dimension spec (N-6, N-7, N-9, N-11, N-12) |
| **HALT conditions hit** | **None.** The enumeration found no site class it cannot cover. No historical caller can select another product's row (N-12, §4). No Sign allowance result changed (N-13/N-13a goldens equal, §3). No registry value beyond `sign` was needed: the N-12 key exists only in test databases. No returned shape changed (§7). |

## 1. Increment-to-file commit map (proposed)

| # | Proposed commit | Files |
|---|---|---|
| A4-0 | `CCP-A4: pre-execution record (C17 enumeration, composition shape, live-table plan)` | `doc/ccp/slices/CCP-A4-pre-execution.md` |
| A4-1 | `CCP-A4: baseline N-13/N-13a goldens (captured on b0e59aa6, pre-A4)` | `libs/subscription/src/tests/fixtures/ccp-a4-sign-corpus.ts`, `fixtures/ccp-a4-sign-equality.golden.json`, `ccp-a4-sign-equality.integration.spec.ts`; `apps/api/src/tests/ccp-a4-ats-sign-availability.integration.spec.ts`, `apps/api/src/tests/fixtures/ccp-a4-ats-sign-availability.golden.json`; `apps/sign-service/src/tests/ccp-a4-ats-sign-consumption.integration.spec.ts`, `apps/sign-service/src/tests/fixtures/ccp-a4-ats-sign-consumption.golden.json` (all new) |
| A4-2 | `CCP-A4: product_key + composition_role migration (registry CHECKs, composite FK, index swap) and Prisma models` | `libs/subscription/prisma/migrations/20261025140000_ccp_a4_product_dimension/migration.sql` (new); `libs/subscription/prisma/schema.prisma` |
| A4-3 | `CCP-A4: closed product registry and explicit product context in libs/subscription` | `libs/subscription/src/lib/product-registry.ts` (new); `allowance.service.ts`, `capacity.service.ts`, `development-subscription.ts`, `free-personal-subscription.ts`, `billing/subscription-lifecycle.service.ts`, `src/index.ts`; `prisma/seed-development-subscription.ts` |
| A4-4 | `CCP-A4: re-point every caller to explicit Sign product context` | `apps/api/src/document-signing/signature-availability.service.ts`; `apps/sign-service/src/app/{aramo-sign-allowance.gate,integrations/sign-api.service,personal/personal-send.gate,billing/aramo-sign-storage.gate,billing/esign-billing.controller,billing/esign-billing-reconcile.worker}.ts`; `apps/platform-admin/src/app/platform/platform-sign.controller.ts`; `pact/provider/src/verify-sign.ts` |
| A4-5 | `CCP-A4: re-point specs; shared A4 test helper; product-dimension spec (N-6, N-7, N-9, N-11, N-12)` | `libs/subscription/src/tests/fixtures/ccp-a4.ts`, `fixtures/ccp-a4-compensating.sql`, `ccp-a4-product-dimension.integration.spec.ts` (new); `libs/subscription/src/tests/{allowance,subscription-lifecycle,commercial-catalog-a1,commercial-catalog-a1-upgrade,personal-free,commercial-audit-policy}.integration.spec.ts`; `apps/sign-service/src/tests/{billing,storage-quota}.spec.ts`, `{personal-free,sign-api}.integration.spec.ts`; `apps/platform-admin/src/tests/platform-sign.controller.spec.ts`, `{personal-signup,sign-signup}.integration.spec.ts`; plus the N-12 cases added to the two app specs of A4-1 |
| A4-6 | `CCP-A4: acceptance evidence` + `CCP-A4: regenerate repo map` | `doc/ccp/slices/CCP-A4-acceptance.md` (new); `doc/generated/repo-map.projects.json` |

A4-1 is the first code commit on purpose. Its goldens were written by the **baseline code** before any A4 change. In the A4-5 state, the only change to the library equality spec is the call adapter (the explicit `SIGN_PRODUCT_KEY`) and its import. The two app specs are unchanged in their golden part, because the product context lives inside the services under test.

**Unchanged:** every existing migration; `pact/provider/src/verify-api.ts` (§7); `openapi/*`; `libs/identity`; `apps/platform-web`; every returned DTO.

## 2. The C17 enumeration (A0-C17, PBD §7.4)

The method and the full list are in the pre-execution record §2. Measured outcome:

| Class | Count | Re-pointed |
|---|---|---|
| `tenantSubscription` delegate references in 5 library files (Program Plan "23 call sites in 5 files") | 23 | 23 |
| of which product-blind open-row selectors (MP-A2 §1.4 "12 selectors in 5 files") | 12 | 12, all through `openBaseSubscription(tenant, product)` or a product filter on the two cross-tenant scans |
| raw `ON CONFLICT` arbiters (MP-A2 §1.4; Program Plan "2 raw test INSERTs") | 2 | 2 (`verify-sign.ts:250`, `:524` after the edit) |
| plan-side reads (catalog, by key, by id, `planForPrice`) | 7 | 7 |
| indirect non-test call sites (10 groups) | 23 | 23 |
| post-chain raw/Prisma test writes | 6 | 6 |
| pre-A4 test seed (upgrade replay) | 1 | none needed (it runs before A4; A4 backfills it) |
| explicit migration lists | 8 | 8 (A4 appended) |

**Type-checker residue (method M3).** The oracle compiled `libs/subscription`, `apps/sign-service`, `apps/platform-admin`, `apps/api/src/document-signing`, the `apps/api` specs that import the lib, and `pact/provider/src/verify-sign.ts`, specs included. After the non-test re-points, it reported **0** new diagnostics in non-test code. It reported **175** new diagnostics in specs: 12 in the new equality spec's adapter (expected; then updated), and **163** in 5 existing library specs (162 call sites plus 1 Prisma `create`), all updated. After the updates: **0** new diagnostics. Mock-based unit specs, which the checker cannot see, needed **5** assertion updates (`billing.spec.ts` ×2, `storage-quota.spec.ts` ×2, `platform-sign.controller.spec.ts` ×1). They were found by running the suites.

## 3. N-8 counts and N-13 / N-13a outputs

### 3.1 N-8 before/after (real Postgres 17, `ccp-a4-sign-equality.integration.spec.ts`)
Corpus seeded on the pre-A4 schema, then the A4 migration applied over it:

| Table | Pre-migration total | Post-migration `product_key = 'sign'` | Other values |
|---|---|---|---|
| `Plan` | 5 | 5 | 0 |
| `TenantSubscription` (open and ended) | 14 (13 open) | 14, all `composition_role = 'BASE'` | 0 |

The pre-migration counts equal the counts the baseline capture recorded. The migration's own guard RAISEs on any count change, missing backfill or duplicate open BASE row. Replay on a second populated database (25 rows, 5 ended): 25 → 25.

### 3.2 N-13 Sign allowance (golden `libs/subscription/src/tests/fixtures/ccp-a4-sign-equality.golden.json`, captured on `b0e59aa6`)
15 corpus tenants. Each has 21 observations: status, capacity, account, subscribing owner, stale reservations, `resolveStale`, reserve/retry/consume/retry, reserve/release, release-of-consumed, reserve-again, historical/retry, status-after, capacity reserve/retry/release, account-after. That is 315 recorded results. Covered: monthly period anchored on the subscription (incl. the Jan-31 day clamp), no rollover, idempotency per send key, CONSUMED rows always counted, RELEASED not counted, stale reservations (ACCEPTED/NOT_ACCEPTED/UNKNOWN), the 80% (WARNING) and 100% (EXHAUSTED) thresholds, hard refusal at exhaustion, explicit unlimited with metering, the Free Personal day window, PAST_DUE inside and after grace, INCOMPLETE, ended-only, no subscription, a plan without the allowance, and storage capacity.
**Result: post-A4 observation === golden, byte for byte. ✅**

### 3.3 N-13a ATS RTR/Offer (sign-only tenants)
| Spec | Golden | Observations | Result |
|---|---|---|---|
| `apps/api/src/tests/ccp-a4-ats-sign-availability.integration.spec.ts` (real `SignatureAvailabilityService` + `SignatureRoutingService.forNewSend` over a real `AllowanceService`) | `apps/api/src/tests/fixtures/ccp-a4-ats-sign-availability.golden.json` | 7 tenants × 4 (recruiter view, policy view, RTR send routing, Offer send routing) = 28 | equal ✅ |
| `apps/sign-service/src/tests/ccp-a4-ats-sign-consumption.integration.spec.ts` (real `AramoSignAllowanceGate.guardSend` + `SignApiService.availability`) | `apps/sign-service/src/tests/fixtures/ccp-a4-ats-sign-consumption.golden.json` | 5 tenants × 9 (availability before/after, RTR send, RTR retry, Offer send, Offer failed while DRAFT, Offer failed after acceptance, ledger by state, metering events) = 45 | equal ✅ |

## 4. N-12 isolation fixture outputs

Second key `ccp_a4_isolation_test`. It is registered **only inside each test database** by replacing the two registry CHECKs there (`fixtures/ccp-a4.ts` `registerIsolationTestProduct`; inline in the two app specs). Its plan carries the same metered keys as Sign with different numbers (`sign.envelopes` 7/month, storage 5 bytes), so a product-blind read would be visible.

| Proof | Test | Result |
|---|---|---|
| The production registry rejects the key: `Plan` insert fails on `Plan_product_key_registry_check`; `TenantSubscription` insert fails on the registry CHECK or the composite FK | `ccp-a4-product-dimension…` "the production registry rejects the N-12 test key" | ✅ |
| Code registry = DB CHECK admitted set = `['sign']`; `isProductKey`/`assertProductKey` reject the key; `getStatus`, `capacity.status` and `reconcile` throw `ProductContextError` for it | "code registry = DB CHECKs", "the code registry rejects the test key" | ✅ |
| The key appears in no migration, seed, `deploy/` or `tools/` file (source scan) | "the test key appears in no migration…" | ✅ (0 files) |
| Fixture tenant holds an open BASE `sign` row **and** an open BASE second-product row | "the fixture…" | ✅ |
| Every Sign read path resolves the sign row: status (limit 100, not 7), capacity, account (MANUAL included plan), subscribing owner (null, not the other row's `iso-owner`), catalog, historical period from the sign anchor, the reserve→consume path (limit 100) | "every Sign read path…" | ✅ |
| **ATS path** (`signature-availability.service.ts:102`) and RTR/Offer routing, with a second-product row added to 4 golden tenants (including one with no sign row, which stays NOT_SUBSCRIBED) | api spec "N-12: … ATS RTR/Offer path still resolves the sign row" | ✅ equal to golden |
| **Sign send gate** and Sign API availability, on 5 mirror tenants that each also hold a second-product row | sign-service spec "N-12: … ATS-triggered Sign charging still uses the sign row" | ✅ equal to golden |
| Reconcile and eligibility refresh for `sign` never fetch or touch the other row (provider refs fetched: 0 of the other product; row snapshot unchanged) | "reconcile and eligibility refresh…" | ✅ |
| A `sign` webhook for the other product's provider subscription is IGNORED; the row is unchanged | "a sign webhook for the other product subscription…" | ✅ |
| Sign checkout passes (product-blind, the other product's open SELF_SERVICE ACTIVE row would refuse it ALREADY_SUBSCRIBED); activation ends only the sign MANUAL row; a provider move to the other product's price does not re-point the sign row; the other row is unchanged throughout | "sign checkout + activation…" | ✅ |
| A checkout of the other product's plan through `sign` is refused (`PLAN_NOT_SELLABLE`) | "a checkout of the other product plan…" | ✅ |
| Removing the second-product row leaves every Sign result byte-identical | "removing the second product row…" | ✅ |
| N-7: a subscription whose product differs from its plan's is refused at the DB (insert ×2, `plan_id` re-point, a referenced plan's `product_key` change), all on `TenantSubscription_plan_id_product_key_fkey` | "N-7: …" | ✅ |

## 5. Proof of no default reliance (A0-C7, N-11)

1. **No default ever existed.** The migration adds the columns nullable, backfills them with explicit `UPDATE`s, then sets NOT NULL. There is no transitional `DEFAULT`.
2. `information_schema.columns` after the migration: `Plan.product_key`, `TenantSubscription.product_key` and `TenantSubscription.composition_role` are all `is_nullable = NO` with `column_default = NULL`. ✅
3. A write that omits any of them fails (3 negative inserts). ✅ So every write path that the suites exercise (lib 215 tests, sign-service 310 unit + 49 AppModule integration, platform-admin 216 unit + 51 integration, s2-erasure 16, Pact verify-sign) proves by passing that it names the values.
4. Prisma: the fields have no `@default`, so every `tenantSubscription.create` must pass them. They are passed explicitly at `development-subscription.ts`, `free-personal-subscription.ts` and `subscription-lifecycle.service.ts` `openRow`.
5. Source scan: every raw `INSERT INTO subscription."Plan"|"TenantSubscription"` in non-test `apps/`, `libs/`, `pact/provider/src`, `tools/` and `deploy/` names `product_key` (and `composition_role` for subscriptions): 0 offenders. The two Pact arbiters are re-pointed. The old arbiter text appears 0 times. ✅

## 6. Index swap under the live-table plan (N-9)

| Proof | Result |
|---|---|
| After A4 exactly one `one_open*` index exists: `TenantSubscription_one_open_base_per_tenant_product` = `UNIQUE … (tenant_id, product_key) WHERE ((ended_at IS NULL) AND (composition_role = 'BASE'::text))` | ✅ |
| A second open sign BASE row is refused; ended rows are unlimited (3 rows for one tenant); `composition_role = 'ADD_ON'` is refused by the CHECK | ✅ |
| The arbiter `ON CONFLICT (tenant_id, product_key) WHERE ended_at IS NULL AND composition_role = 'BASE'` infers the new index (1 row, then 0) | ✅ |
| Replay on a populated pre-A4 database: A4 applies, the new index is built before the old one is dropped (one transaction, `lock_timeout 5s`), counts are kept | ✅ |
| **Reversible while every row is sign:** the recorded compensating SQL restores the old index and drops the columns (row count kept), and A4 then re-applies cleanly | ✅ |
| The compensating SQL is **refused** once a non-sign row exists | ✅ |

## 7. Returned shapes, Pact and gates

- **No returned shape changed.** `AccountView`, `SubscriptionView`, `CatalogPlanView`, `AllowanceStatus` and the Sign API availability body gain no field; the goldens prove byte equality. So no `pact/provider/src/verify-api.ts` registration is required (it lists no subscription migration and reads no subscription table).
- **Pact `verify-sign`: run locally, green.** The consumer pacts were generated first by `pact/consumers/{sign-consumer,sign-web-consumer,sign-workspace-consumer}` (11 + 6 + 11 = 28 consumer interactions, all passed). The provider then verified the 3 pacts (aramo-core, sign-web, sign-workspace → sign-service): 1 test passed. Consumer count and provider-verified pact count are reported separately, as required.

| Gate | Result |
|---|---|
| `nx run-many -t build -p subscription sign-service platform-admin api --skip-nx-cache` | ✅ 4 projects + 75 dependency tasks |
| ESLint on every changed or new `.ts` file (36) | ✅ 0 errors (103 warnings, `no-non-null-assertion` in specs) |
| `contract-parity:check` | ✅ 670 live routes, 0 orphan, 0 unclassified |
| `openapi:drift-check` | ✅ ok (9 files) |
| `orphan-scopes:check` | ✅ ok |
| `env:passthrough-check` | ✅ (no new env var) |
| `repo-map:generate` / `repo-map:check` | ✅ regenerated (`doc/generated/repo-map.projects.json`); check ok |
| `scripts/verify-vocabulary.sh` | ✅ Tier 1, Tier 2 and Front-Door clean. A4 touches no vocabulary surface and no exemption allowlist. |

## 8. Tests run and not run

| Suite | Result |
|---|---|
| `libs/subscription` (unit + `ARAMO_RUN_INTEGRATION=1`, 14 files, incl. the 2 new A4 specs) | ✅ 215 passed |
| `apps/sign-service` unit (25 files) | ✅ 310 passed |
| `apps/sign-service` AppModule integration specs that glob the subscription migrations (`personal-free`, `recipient-inbox`, `sign-account`, `sign-api`, `sign-event-grant`, `sign-legal`, `sign-webhooks`) | ✅ 49 passed |
| `apps/sign-service` `ccp-a4-ats-sign-consumption.integration.spec.ts` | ✅ 3 passed |
| `apps/platform-admin` unit (9 files) | ✅ 216 passed |
| `apps/platform-admin` `personal-signup` + `sign-signup` integration (explicit lists, A4 appended) | ✅ 51 passed |
| `apps/api` `ccp-a4-ats-sign-availability.integration.spec.ts` | ✅ 3 passed |
| `apps/api` `signature-availability`, `external-signature-providers`, `esignature-integration` unit | ✅ 39 passed |
| `apps/api` `s2-erasure-integrity.integration.spec.ts` (applies every lib's migrations, incl. A4) | ✅ 16 passed |
| Pact `verify-sign` | ✅ (above) |
| **Not run:** the full `nx run api` suite (instructed, and CLAUDE.md engineering law vs PBD §8: the PBD requires one full local run before the single program push; that belongs to the lead at program acceptance); `apps/sign-web` (it imports only the legal registry from `@aramo/subscription`; no changed export is used); `pact:provider` for verify.ts / verify-api.ts / verify-ti.ts (no contract they verify reads the subscription schema). | — |

Host load: integration ran with `--maxWorkers=2`. One `ccp-a4-product-dimension` run hit the default 5 s per-test timeout on the source-scan and replay tests. That was environment noise: the spec now sets a 120 s per-test timeout, and the re-run was green.

## 9. Recovery and rollback

- Code: revert A4-2…A4-5.
- Schema: the compensating SQL in pre-execution record §5, held as `libs/subscription/src/tests/fixtures/ccp-a4-compensating.sql` and proved in §6. It also restores A3's interim CHECK, when present. It must be applied together with the code revert, and it is refused unless every row is `sign`/`BASE`.
- Production execution of the A4 migration or its compensation is **not authorized** (PBD §7.5, A0-C15).

## 10. Typed divergences

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| **TD-A4-1** | Executor choice (schedule leaves it to the record) | Composition shape **(a)**: `composition_role` column, v1 CHECK `BASE`, index predicate names BASE (pre-execution §3) | For Lead/Architect visibility at the program acceptance review |
| **TD-A4-2** | Stricter than the instrument | N-11 permits a transitional `DEFAULT 'sign'`. A4 never creates one (explicit backfill + NOT NULL) | None needed |
| **TD-A4-3** | Interpretation of N-11 "required argument" | `product_key` is a required **positional** argument for read methods (`getStatus(tenant, product, key, at)`, `account(tenant, product, key, at)`, `catalog(product, tenant)`, `handleEvent(evt, product, at)`, `reconcile(product, at, limit)`, …) and a required field for object-argument methods. `consume`/`release` touch only the usage ledger but also take it, and check it against the key mapping. | Breaking signature change inside the program branch. All callers re-pointed (§2). |
| **TD-A4-4** | Behaviour at an invalid boundary (new) | An allowance or capacity key outside a registered namespace, or of another product, now **throws** `ProductContextError` (fail closed). Before, such a key returned NOT_SUBSCRIBED. No shipped caller passes one (the goldens are unchanged). | Recorded |
| **TD-A4-5** | Webhook detail text (new path only) | A provider subscription or checkout of another product, arriving through a product's webhook, is `IGNORED` with detail `subscription belongs to another product than <p>` (or `checkout plan belongs…`). It cannot occur with sign-only data. | Recorded |
| **TD-A4-6** | Lead correction 1 (2026-10-25) | Migration renamed `20261025120000` → **`20261025140000_ccp_a4_product_dimension`** (A3 holds `20261025120000`) | Applied everywhere; pre-execution addendum §9 |
| **TD-A4-7** | Lead correction 2 (2026-10-25); merge-time verification owed | The A4 migration carries a guarded block that replaces A3's interim CHECK on `subscription."CommercialChangeRequest".product_key` with **`CommercialChangeRequest_product_key_registry_check`** (`IN ('sign')`). It drops every CHECK on that table whose definition references `product_key`; the **expected dropped constraint is `CommercialChangeRequest_product_key_check`**. It is a no-op when the table or column is absent (this worktree). It was proved against a stand-in table with that interim CHECK in the replay test (§6). | **Lead to verify** against A3's real constraint after the merge (name, and that no other `product_key` CHECK exists on the table that should survive) |
| **TD-A4-8** | Shared-helper law vs explicit lists | The 6 library lists use the shared helper `fixtures/ccp-a4.ts`. The 2 `platform-admin` lists (root-relative strings) take the path string directly, because a cross-project import of a lib test fixture would cross the nx boundary. | Recorded |
| **TD-A4-9** | Merge note | Expected textual conflicts with A3: `libs/subscription/prisma/schema.prisma` (A4 edits are only inside `Plan` and `TenantSubscription`) and `commercial-audit-policy.integration.spec.ts` (A4 appends `.concat(CCP_A4_MIGRATION)`). The golden/product specs glob migrations `< 20261025140000`, so A3's migration joins the pre-A4 set automatically. | For the lead at merge |

## 11. Vocabulary result

`scripts/verify-vocabulary.sh`: Tier 1 clean, Tier 2 clean, Front-Door retirement clean. No exemption allowlist touched.

## Post-merge (lead, 2026-10-25)
- **TD-A4-10, merge fix.** On the merged program branch, the A4 guarded block would have dropped every `product_key` CHECK on `CommercialChangeRequest`, including A3's `CommercialChangeRequest_tenant_product_check` (tenant and product both NULL or both set). It now drops the interim `CommercialChangeRequest_product_key_check` by exact name only, then adds `…_product_key_registry_check`. NULL stays admissible.
- The replay spec now asserts that the pairing CHECK survives when the real A3 table is present.
- Merged-branch validation:
  - typecheck: 5/5 projects;
  - A2, A3 and A4 specs plus the eligibility unit: 4 files, 144/144 tests.
  - Re-ran after regenerating the Prisma client and rebuilding the subscription dist.
- **Architect 2026-10-25:** the base-subscription composition design is accepted for continued implementation; final evidence is kept for the program review.
