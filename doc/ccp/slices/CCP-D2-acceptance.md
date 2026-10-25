# CCP-D2 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.4 **D2** row (`:122`). Governing instruments: PBD, CCP-A1 (§4.1 matrix), PLATFORM-UX-1 Amendment A1 (A1-4a, A1-5). Binding rulings: the Architect disposition of 2026-10-25 on TD-C3-5 / TD-C6-1 / TD-D3-13 (`doc/ccp/decisions.md:138`) and TD-B1-2 (`:57`). The exposure follows the DRAFT CCP-A1 Finance amount scope, FA-3 and FA-6 (not LOCKED).

| | |
|---|---|
| **Slice** | CCP-D2: revenue reporting (MRR, ARR, renewal pipeline by month) |
| **Branch / baseline** | `wip/ccp-d2` at `41a0e3b5` |
| **Pre-execution record** | `doc/ccp/slices/CCP-D2-pre-execution.md` (choices D2-D1…D2-D8) |
| **Local commit SHAs** | **Pending (the lead commits).** The executor committed and pushed nothing. |
| **Migration** | **None.** Read-only slice; no table, no stored figure. |
| **HALT conditions hit** | **None.** No monetary metric on the dashboard (§4). |
| **Delivery status** | **Backend: BUILT (local).** Computation, route, OpenAPI, Pact and tests are in place. **Figure exposure: Finance amount scope (merge-time, TD-MERGE-40).** At the program-branch merge the interim withhold-for-everyone rule was replaced by CCP-R3's LOCKED rule: holders of `platform:billing:read` AND `platform:billing:amount:read` (platform_owner, finance_admin, read_only_auditor) receive `mrr_minor` / `arr_minor` and the bucket `mrr_minor`; commercial_ops and support_admin receive the counts with `amount_withheld: "FINANCE_SCOPE_REQUIRED"`. References to `FINANCE_SCOPE_PENDING` below describe the slice as delivered, before the merge. **Finance › Revenue screen: NOT BUILT.** It needs design release CCP-UI v1.1 (brief §3.5); no v1.1 release exists. |

## 1. Change map (proposed commits; the lead commits)

| # | Proposed commit | Files |
|---|---|---|
| D2-0 | `CCP-D2: pre-execution check` | `doc/ccp/slices/CCP-D2-pre-execution.md` (new) |
| D2-1 | `CCP-D2: revenue derived from commercial records (MRR, ARR, renewal pipeline by month; no ledger)` | `libs/subscription/src/lib/billing/billing-revenue-report.service.ts` (new); `libs/subscription/src/lib/subscription.module.ts`; `libs/subscription/src/index.ts` |
| D2-2 | `CCP-D2: Finance revenue route under platform:billing:read, every amount withheld (FINANCE_SCOPE_PENDING); OpenAPI and gates` | `apps/platform-admin/src/app/platform/platform-commercial-revenue.controller.ts`, `dto/commercial-revenue.dto.ts` (new); `platform.module.ts`; `openapi/platform.yaml`; `ci/config/api-surface-manifest.json` |
| D2-3 | `CCP-D2: tests (oracle reproduction, exclusions, withheld for every role, dashboard no money)` | `libs/subscription/src/tests/ccp-d2-revenue-report.spec.ts`, `ccp-d2-revenue-report.integration.spec.ts`; `apps/platform-admin/src/tests/ccp-d2-revenue-authorization.spec.ts` (all new); `apps/platform-web/src/dashboard/DashboardView.no-money.spec.tsx` |
| D2-4 | `CCP-D2: Pact — revenue route (platform-web / verify-platform-admin)` | `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts` |
| D2-5 | `CCP-D2: acceptance evidence` + `CCP-D2: regenerate repo map` | `doc/ccp/slices/CCP-D2-acceptance.md` (new); `doc/generated/repo-map.*` |

**Totals: 8 new files and 7 modified files (15 paths), plus the 3 regenerated repo-map files (18 paths).**

**Unchanged:**
- every migration;
- the C6 service, controller, DTOs and spec;
- `pact/provider/src/verify-platform-admin.ts` (the existing state `finance records exist` serves the D2 interaction, and the coverage gate picks the route up from controller metadata);
- `pact/provider/src/verify-api.ts` (no apps/api returned shape changed);
- `ci/scripts/verify-orphan-scopes.ts` (`platform:billing:read` was already enforced);
- `doc/ccp/decisions.md`;
- every platform-web source (no screen).

## 2. Design as implemented

**Service `BillingRevenueReportService`** (`libs/subscription`). It reads one `REPEATABLE READ` snapshot opened `READ ONLY`. The computation itself is the pure function `computeRevenue`. It never calls the billing provider.

- **MRR** is the sum, over open BASE subscriptions with source MANUAL or SELF_SERVICE and status ACTIVE or PAST_DUE, of the **pinned** plan version's `list_price_minor`, read checksum-verified through `planVersionTerms`.
  - Only USD prices count, and only per `MONTH`.
  - Amounts are integer minor units; a sum past the safe-integer range fails closed.
- **ARR** = MRR × 12. Both are also given per product (the closed registry, `sign`).
- **Exclusions.** Every other open commercial row is excluded and counted, with **one** reason (first match):
  1. `STATUS_NOT_REVENUE_BEARING`
  2. `PLAN_VERSION_INTEGRITY`
  3. `CONTRACT_PRICED`: a B4 `Contract` on the row, or a contact-sales plan with no price
  4. `NO_LIST_PRICE`
  5. `NON_USD_CURRENCY`
  6. `NON_MONTHLY_INTERVAL`

  `excluded_by_reason` lists all six (zero-filled). FREE and DEVELOPMENT rows are counted apart in `not_commercial_by_source`. A price is never converted, defaulted or inferred.
- **Renewal pipeline by month.** These are the C6 renewal events: `COMMITMENT_END` on any commercial row, and `PERIOD_END` on a provider-linked row.
  - Events are grouped by UTC calendar month, from the as_of month for `months` 1–24 (default 12). Events on or before as_of go to `LAPSED`. Events beyond the horizon are left out.
  - Each bucket gives events by kind, priced and unpriced events, and `mrr_minor`: the MRR of the included rows renewing in it.

**Route** `GET /platform/commercial/finance/revenue?product_key&months` (`PlatformCommercialRevenueController`):
- **Gate:** `@RequireScopes('platform:billing:read')`, platform tier only, read-only.
- **No amount in the response, for any caller (FA-6).** `withheldRevenueDto` builds each field explicitly and never reads an amount field of the report.
  - The response has no `mrr_minor`, no `arr_minor` and no bucket amount.
  - The report, each `by_product` line and each bucket carry `amount_withheld: "FINANCE_SCOPE_PENDING"`.
  - It returns counts, exclusion reasons and renewal-event counts.
- **No tenant filter** (`tenant_id` → 400) and no per-tenant row.

## 3. Report reproduction (the oracle; real Postgres 17; fake Stripe in test mode, no network, no key)

`D2-REP-1`, `libs/subscription/src/tests/ccp-d2-revenue-report.integration.spec.ts`. The output is printed by `formatRevenueReport`. Subscription ids are replaced by the fixture letters.

```
[revenue] as_of=2026-10-26T12:00:00.000Z basis=OPEN_SUBSCRIPTIONS_X_PINNED_LIST_PRICE currency=USD interval=MONTH provider_mode=test
[revenue] MRR=USD 75.00 ARR=USD 900.00 (ARR = MRR x 12)
[revenue]   product=sign subscriptions=4 MRR=USD 75.00 ARR=USD 900.00
[revenue] open commercial subscriptions: 10 included=4 excluded=6 {"STATUS_NOT_REVENUE_BEARING":1,"PLAN_VERSION_INTEGRITY":0,"CONTRACT_PRICED":2,"NO_LIST_PRICE":1,"NON_USD_CURRENCY":1,"NON_MONTHLY_INTERVAL":1}
[revenue] not commercial (not counted as revenue): {"DEVELOPMENT":1}
[revenue] renewal pipeline 2026-10..2027-09 (12 months)
[revenue]   LAPSED: events=1 commitment_end=1 period_end=0 priced=1 unpriced=0 mrr=USD 20.00
[revenue]   2026-10: events=0 commitment_end=0 period_end=0 priced=0 unpriced=0 mrr=USD 0.00
[revenue]   2026-11: events=4 commitment_end=1 period_end=3 priced=2 unpriced=2 mrr=USD 40.00
[revenue]   2026-12: events=1 commitment_end=1 period_end=0 priced=1 unpriced=0 mrr=USD 15.00
[revenue]   2027-01 … 2027-09: events=0 (9 empty months)
[revenue]   excluded SA MANUAL ACTIVE plan=aramo-sign-included-v1 reason=NO_LIST_PRICE
[revenue]   excluded SK MANUAL ACTIVE plan=aramo-sign-standard-business-v1 reason=CONTRACT_PRICED
[revenue]   excluded SQ MANUAL ACTIVE plan=d2-no-interval-fixture reason=NON_MONTHLY_INTERVAL
[revenue]   excluded SE MANUAL ACTIVE plan=d2-eur-fixture reason=NON_USD_CURRENCY
[revenue]   excluded SN MANUAL ACTIVE plan=aramo-sign-enterprise-v1 reason=CONTRACT_PRICED
[revenue]   excluded SI SELF_SERVICE INCOMPLETE plan=aramo-sign-standard-business-v1 reason=STATUS_NOT_REVENUE_BEARING
```

(The 9 empty months 2027-01…2027-09 are printed one line each in the test output; they are collapsed here.)

**Fixtures:**

| Fixture | Record | Effect |
|---|---|---|
| A | Governed MANUAL on the operator plan (real request → approve → apply); commitment ends in 20 d | `NO_LIST_PRICE` |
| B | SELF_SERVICE ACTIVE, Standard Business USD 2000/MONTH (checkout + provider state) | Included 2000 |
| C | SELF_SERVICE moved to PAST_DUE by a provider re-sync | Included 2000 |
| P | Raw MANUAL Standard Professional USD 1500/MONTH; commitment ends in 45 d | Included 1500 |
| G | Raw MANUAL Standard Business; commitment lapsed 3 d ago | Included 2000 |
| K | Governed open on Standard Business **with a B4 contract** (real apply) | `CONTRACT_PRICED`, even though its pinned version lists USD 2000 |
| N | Raw MANUAL Enterprise (contact sales, no price) | `CONTRACT_PRICED` |
| I | Raw SELF_SERVICE INCOMPLETE, provider-linked | `STATUS_NOT_REVENUE_BEARING` |
| E | Raw MANUAL on a EUR-priced fixture version | `NON_USD_CURRENCY` |
| Q | Raw MANUAL on a USD price with no interval | `NON_MONTHLY_INTERVAL` |
| V | DEVELOPMENT | Not commercial |
| X | An **ended** Standard Business row | Never counted |

MRR = 2000 + 2000 + 1500 + 2000 = **7500** minor units (USD 75.00). ARR = **90000** (USD 900.00).

**The oracle.** It is one raw SQL statement over `TenantSubscription`, `PlanVersion.content->'plan'` and `Contract`. It classifies with a `CASE` in the same precedence, sums with `FILTER`, and buckets with `to_char(at AT TIME ZONE 'UTC','YYYY-MM')` over a `generate_series` horizon. It uses none of the service's code. The tests compare the service with the oracle using `toEqual`.

| Test | Output |
|---|---|
| **D2-REP-1** MRR, ARR, classification and exclusions | Equal to the oracle: MRR 7500, ARR 90000 (= MRR × 12), per-row reason of all 10 commercial rows, `excluded_by_reason`, `not_commercial_by_source` |
| **D2-EXC-1** exclusions counted, one reason each | `{open_commercial_subscriptions: 10, included: 4, excluded: 6}`; reasons as in the table; K's pinned version reads USD 2000 yet K is `CONTRACT_PRICED`; V and X absent; "EUR" never in the report |
| **D2-PIPE-1** renewal pipeline by month | Equal to the oracle at 12 and 2 months. LAPSED = G (2000). 2026-11 = A (commitment, unpriced) + B, C (period end, 2 × 2000) + I (period end, unpriced) → 4 events, `mrr_minor` 4000. 2026-12 = P (1500). `months` 0 → `RangeError` |
| **D2-REP-2** figures follow the records | A further Professional row raises MRR by exactly 1500, and the oracle agrees. Ending it restores MRR |
| **D2-FILTER-1** product filter | `product_key=sign` equals the unfiltered report; an unregistered product is refused |
| **D2-RO-1** no ledger, no stored figure | SHA-256 of `TenantSubscription`, `Plan`, `PlanVersion`, `Contract` and `CommercialAuditEvent` is unchanged across two reports. A write inside the report transaction raises "read-only transaction". `information_schema` has 0 columns named mrr / arr / revenue and 0 tables named revenue / mrr |
| D2-U-1…U-6 (unit, `ccp-d2-revenue-report.spec.ts`) | Exact sum and ARR; one reason per row in precedence order (11 cases incl. TRIALING, INCOMPLETE + EUR, open CANCELED, a tampered checksum, a contract, CONTACT_SALES, OPERATOR, EUR, null currency, null or YEAR interval); non-commercial sources apart; UTC month bucketing (as_of itself is LAPSED; 2026-10-31T23:59:59.999Z is 2026-10; PERIOD_END only when provider-linked; beyond the horizon left out); `months` 1..24; safe-integer overflow fails closed |

## 4. Route, dashboard, Pact and gates

| Run | Result |
|---|---|
| `apps/platform-admin/src/tests/ccp-d2-revenue-authorization.spec.ts` (real JwtAuthGuard + RolesGuard; the service stub returns distinctive amounts) | **17 / 17**. See the breakdown below this table. |
| **Dashboard no-money** `DashboardView.no-money.spec.tsx` | **5 / 5** (C6-DASH-1…3 unchanged, plus 2 new). D2-DASH-1: 0 console sources call `/finance/revenue`. D2-DASH-2: the dashboard view, the `PlatformDashboard*` contract and the `getDashboard` call carry no MRR, ARR, revenue, pipeline, amount, price, currency or `_minor` field. The dashboard tests (2 files) pass **15 / 15**. |
| Consumer `platform-web-consumer` (pact file deleted first; serial, `--maxWorkers=1`) | 3 files, **172 / 172** tests. The pact file has **173 interactions**, 4 of them D2: the allowed read by finance_admin (200, counts, `amount_withheld` asserted, no `_minor` / mrr / arr key), catalog_manager 403, super_admin 403 and the tenant tier 403 (GATE_ROUTES). The coverage header now lists 31 CCP routes. |
| Provider `verify-platform-admin` (`ARAMO_RUN_PACT_PROVIDER=1`, serial) | **2 / 2 provider tests**: the CCP route coverage gate (incl. the new route) and verification of all **173** interactions. The D2 interaction verified against the real AppModule under the existing state `finance records exist`. |
| Consumer vs provider counts (reported separately) | 173 consumer interactions; 173 verified by the platform-admin provider |
| `contract-parity:check` | 709 live routes (707 governed), 540 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified. Baseline (real index, new controller untracked): 708 live, 539 ops. The change is **+1 / +1 / +1**. Under the real index alone the check reports 1 `openapi-orphan` only because the new controller is untracked. |
| `openapi:drift-check` | ok (9 files) |
| `redocly lint openapi/platform.yaml` | valid; 2 warnings (the same as the C6 baseline) |
| `orphan-scopes:check` | ok (no new scope) |
| `tests:integration:check`, `error-codes:check`, `env:passthrough-check` | ok (49 integration roots; no new error code; no new env var) |
| `bash scripts/verify-vocabulary.sh` | OK under the real index and under a temporary index with the new files: Tier 1, Tier 2 and front-door are clean. No exemption touched. |
| `repo-map:generate` / `repo-map:check` | Regenerated (3 files modified: `repo-map.{coupling,files,projects}.json`); check ok. Run under the temporary index (TD-D2-9) after this record was written |
| `nx run-many -t build typecheck lint -p subscription platform-admin aramo-platform-web platform-web-consumer-pact aramo-pact-provider --skip-nx-cache` | **All passed** (5 projects + 30 dependency tasks), 0 lint errors. **`aramo-pact-provider:typecheck` now passes** (C6 had recorded TD-C6-11 there). Dist markers: `BillingRevenueReportService` in `dist/libs/subscription/src/index.d.ts`; `dist/apps/platform-admin/src/app/platform/platform-commercial-revenue.controller.js` present. |
| ESLint on the changed and new files | 0 errors. 9 warnings, all non-null assertions in the D2 integration spec (as in C6) |

**Route authorization breakdown (17 / 17):**
- **D2-R-1, all 6 CCP roles:** no amount anywhere in any response. None of the 5 stub amounts appears; there is no `_minor` / mrr / arr / list_price key and no subscription or tenant id.
  - The 5 billing readers (platform_owner, finance_admin, commercial_ops, support_admin, read_only_auditor) get **200** with exactly the withheld projection: `amount_withheld: FINANCE_SCOPE_PENDING` at the top level, on `by_product` and on every bucket.
  - catalog_manager gets **403** `missing_scopes [platform:billing:read]`.
- **D2-R-2:** catalog_manager and **super_admin** are refused **403**, and the computation never runs.
- **D2-R-3:** no token → 401; a tenant-tier token → 403.
- **D2-R-4:** filters are passed through typed.
- **D2-R-5:** 6 × 400 `VALIDATION_ERROR` (months 0 / 25 / 1.5, `product_key=ats`, `tenant_id`, an unknown parameter).

## 5. Tests run and not run

| Suite | Result |
|---|---|
| D2 lib specs (`ARAMO_RUN_INTEGRATION=1`, `--maxWorkers=2`): integration 6 + unit 6 | **12 / 12** (first run) |
| `libs/subscription` whole lib, unit mode | 50 files: 19 passed, 31 skipped (integration-gated); **309 passed**, 440 skipped |
| `apps/platform-admin` whole app, `ARAMO_RUN_INTEGRATION=1 --maxWorkers=2` (AppModule-booting specs included) | 39 files, **760 / 760** |
| `apps/platform-web` whole app (`--maxWorkers=2`) | 47 files, 541 / 542. The 1 failure is `CatalogView.spec.tsx` B2-W-ROLE super_admin, an untouched file (load flake); re-run serially **16 / 16** twice |
| `apps/sign-service` `billing.spec`, `ccp-c1-billing-commands.spec` (`SubscriptionModule` consumers) | 2 files, **19 / 19** |
| `ccp-c6-finance-authorization.spec.ts` (regression, beside D2's) | **17 / 17** |
| Pact consumer and provider | See §4 |
| **Not run (no screen):** visual parity, axe, keyboard for Finance › Revenue | Not built: design release CCP-UI v1.1 is needed (brief §3.5) |
| **Not run (instructed / out of scope):** the full `nx run api`; the `verify-api`, `verify-sign`, `verify.ts` and `verify-ti.ts` providers | No apps/api or sign-service returned shape changed; no migration |

## 6. Recovery and rollback

- The slice is read-only, so there is nothing to compensate. Revert D2-1…D2-4.
- There is no migration and no data change. The route has no write path, and the report transaction is READ ONLY.

## 7. Exposure path (for the Finance amount scope LOCK)

When `Aramo-CCP-A1-Amendment-A1-Finance-Amount-Scope` is LOCKED and its scope is seeded (FA-5), exposing the figures is a **code change** in `platform-commercial-revenue.controller.ts`:
- holders of the new scope receive `mrr_minor`, `arr_minor` and the bucket amounts;
- every other `platform:billing:read` holder keeps the marker `FINANCE_SCOPE_REQUIRED` (FA-4).

The OpenAPI schema, the Pact interaction and the D2-R specs change with it. The computation and its oracle proof do not change.

## 8. Typed divergences

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| **TD-D2-1** | Rule reading | Revenue-bearing statuses are ACTIVE and PAST_DUE. TRIALING, INCOMPLETE and an open CANCELED row are excluded (`STATUS_NOT_REVENUE_BEARING`). The brief named the exclusions as "non-USD, missing or contract-priced"; status and interval exclusions are added and counted the same way. | **Lead confirmation** |
| **TD-D2-2** | Rule reading | A row with a B4 contract is `CONTRACT_PRICED` even when its pinned plan has a USD list price (fixture K). Contract terms are evidence text, so the negotiated price is not derivable, and the list price would misstate it. | **Lead confirmation** |
| **TD-D2-3** | Scope / instruction wording | The brief says the route "withholds all amounts for all 6 roles". The route is gated by `platform:billing:read` (C6 Finance gate; v1.1 brief §3.1 / §3.5 visibility), so 5 roles receive the withheld report and **catalog_manager is refused 403**, as is super_admin. All 6 roles and super_admin are tested; no role receives an amount. | Recorded (D2-D1) |
| **TD-D2-4** | Exposure gated | Every amount is withheld for every caller (FA-6) because the Finance amount scope is a DRAFT. The figures are proven only at the service level and through the SQL oracle (§3), never through the route. | Until the scope LOCK (§7) |
| **TD-D2-5** | UI not built | Finance › Revenue (route `/commercial/finance/revenue`) is specified only in the CCP-UI v1.1 **brief** (`ARAMO-Claude-Design-Prompt-CCP-UI-v1_1-Finance-Ops-20261025.md`, SHA-256 `ac9bc7c9…158f88`, §3.5). No v1.1 release or manifest exists, so there is no screen, rail item, parity, axe or keyboard test. | Design release CCP-UI v1.1, then a D2-UI follow-up |
| TD-D2-6 | Rule reading | Renewal events reuse the C6 definition (TD-C6-10): `COMMITMENT_END` on any commercial row, and `PERIOD_END` only for provider-linked rows. A SELF_SERVICE row can therefore appear in two months (period end and commitment end). Buckets are UTC calendar months. | Recorded |
| TD-D2-7 | Scope boundary | Platform-wide aggregate only. There is no tenant filter and no per-tenant line on the route; per-tenant revenue is FA-1 material. The per-row classification exists only at the service level (oracle evidence). | Recorded |
| TD-D2-8 | Data gap | Revenue is the list price of the pinned version. It ignores proration, discounts, credits, tax and invoices: C3/C4/C5 are not delivered, and contract invoicing is NOT DELIVERED (TD-B4-4). It is a commercial-records MRR, not a collected-revenue figure. | Recorded |
| TD-D2-9 | Tooling | `contract-parity:check`, `verify-vocabulary.sh` and `repo-map:generate` read git-tracked files. They were run under a temporary `GIT_INDEX_FILE` with intent-to-add entries for the new files; the real index was not touched (the C6 precedent). | Recorded |
| TD-D2-10 | Pre-existing (resolved upstream) | C6 recorded TD-C6-11 (`aramo-pact-provider:typecheck` failing at `verify-sign.ts:850`). On this baseline the target passes. | For the lead (close TD-C6-11) |
| TD-D2-11 | Flake | `CatalogView.spec.tsx` B2-W-ROLE super_admin failed once under the full parallel platform-web run and passed serially twice. The file is untouched by D2. | Recorded |
| TD-D2-12 | Merge note | Expected overlap with parallel slices (D4, D5): `libs/subscription/src/index.ts`, `subscription.module.ts`, `platform.module.ts`, `openapi/platform.yaml` (the "Platform Commercial Finance" tag text), `ci/config/api-surface-manifest.json`, the platform-web consumer (header, constants, GATE_ROUTES, describes) and `doc/generated/repo-map.*` | For the lead |

No correction-1 trigger (PBD §2.4) arose.

## 9. Vocabulary result

`bash scripts/verify-vocabulary.sh`: **OK** (Tier 1, Tier 2 and front-door retirement clean). It passed under the real index and under a temporary index that includes the D2 files. No exemption allowlist was touched.
