# CCP-C6 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.2 C6 row (`:96`). Governing instruments: the Conversion Rule (C-8, C-9, C-23), PLATFORM-UX-1 Amendment A1 (A1-4, A1-4a, A1-5), PLATFORM-UX-1 §3 (pixel parity), and the A1 §4.1 scope matrix.

| | |
|---|---|
| **Slice** | CCP-C6: renewals, outstanding payments, billing reconciliation report |
| **Branch / baseline** | `wip/ccp-c6` at `6b5051a8` (program state after CCP-C1) |
| **Pre-execution record** | `doc/ccp/slices/CCP-C6-pre-execution.md` (design hashes, choices C6-D1…C6-D8) |
| **Local commit SHAs** | **pending (lead commits).** Nothing committed or pushed by the executor. |
| **Migration** | **None.** Read-only slice; no `20261026080000_ccp_c6_*` migration was needed. |
| **HALT conditions hit** | **H-C6-1 (UI part only): the pinned design release CCP-UI v1.0 has no Finance screens** (no renewals queue, no outstanding-payments screen, no reconciliation-report screen; pre-execution §2.1). Building them would be an unpinned design change (PBD `:104`; UX-A1 A1-5). **No C6 screen was built.** The backend part has no HALT: every figure is derived from commercial records (§3, reproduced by an independent oracle). |
| **Delivery status** | Backend (routes, reports, reconciliation output, per-role, Pact): **DELIVERED (local).** Finance screens: **NOT DELIVERED (HALT H-C6-1)**, waiting for a design release that adds them. |

## 1. Commit map (proposed; SHAs pending, lead commits)

| # | Proposed commit | Files |
|---|---|---|
| C6-0 | `CCP-C6: pre-execution check (design pin; HALT H-C6-1 for the UI part)` | `doc/ccp/slices/CCP-C6-pre-execution.md` (new) |
| C6-1 | `CCP-C6: read-only Finance reports (renewals, outstanding payments, reconciliation incl. held activations)` | `libs/subscription/src/lib/billing/billing-finance-report.service.ts` (new); `libs/subscription/src/lib/subscription.module.ts`; `libs/subscription/src/index.ts` |
| C6-2 | `CCP-C6: Finance read routes under platform:billing:read, OpenAPI and gates` | `apps/platform-admin/src/app/platform/platform-commercial-finance.controller.ts`, `dto/commercial-finance.dto.ts` (new); `platform.module.ts`; `openapi/platform.yaml`; `ci/config/api-surface-manifest.json` |
| C6-3 | `CCP-C6: tests (reconciliation reproduction, held activations, read-only, USD, per-role, dashboard no-money)` | `libs/subscription/src/tests/ccp-c6-finance-report.integration.spec.ts`, `ccp-c6-finance-report.spec.ts`; `apps/platform-admin/src/tests/ccp-c6-finance-authorization.spec.ts`; `apps/platform-web/src/dashboard/DashboardView.no-money.spec.tsx` (all new) |
| C6-4 | `CCP-C6: Pact — Finance routes (platform-web / verify-platform-admin)` | `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts`; `pact/provider/src/verify-platform-admin.ts` |
| C6-5 | `CCP-C6: acceptance evidence` + `CCP-C6: regenerate repo map` | `doc/ccp/slices/CCP-C6-acceptance.md` (new); `doc/generated/repo-map.{coupling,files,projects}.json` |

Totals: **9 new files, 10 modified files (19 paths)**. **Unchanged:** every migration; every existing spec; `pact/provider/src/verify-api.ts` (no apps/api returned shape changed); `verify-sign.ts`; `stripe-wire.ts` (no Stripe call, no new vocabulary exemption); `ci/scripts/verify-orphan-scopes.ts` (`platform:billing:read` was already enforced by C1); `doc/ccp/decisions.md`; the shell, the rail and every existing platform-web source (B1 owns them).

## 2. Design as implemented

**Service** `BillingFinanceReportService` (libs/subscription). Three methods. Each runs in **one `REPEATABLE READ` transaction opened with `SET TRANSACTION READ ONLY`**: a consistent snapshot in which any write raises (C6-RO-1). It never calls the billing provider.

| Report | Rows | Figures |
|---|---|---|
| `renewals` | Open BASE rows with source MANUAL or SELF_SERVICE: `COMMITMENT_END` (`commitment_end` ≤ as_of + `within_days`) and, for a provider-linked row, `PERIOD_END` (`current_period_end` in the same horizon). Past dates are listed with `lapsed: true`. Ordered by `renewal_at`. | The pinned version's list price; `days_until` (rounded up), `commitment_months` (pinned content), `cancel_at_period_end`, `cancel_requested_within_commitment` |
| `outstandingPayments` | Open MANUAL / SELF_SERVICE rows in `PAST_DUE` or `INCOMPLETE`. Grace state from `grace_until` (`IN_GRACE` / `GRACE_ENDED` / `NO_GRACE_DATE`). Soonest grace end first. | The pinned version's list price. `amount_due` is always `null`, reason `INVOICE_READ_NOT_DELIVERED` (invoices are CCP-C3) |
| `reconciliationReport` | Every open BASE row against its pinned version and the tenant's effective entitlements (`entitlement."TenantEntitlement"`; revoked rows are excluded automatically once the A7 `revoked_at` column exists). Also: product capabilities held with no open subscription; every open reconciliation flag, with `governed_subscription_open` listed as a **held activation** (C-8: the governed row, the intent and its status, the held plan, unconfirmed commands, and `resolution` `UNRESOLVED` or `PENDING_PROVIDER`); and command and inbox exception counts. `status` = `RECONCILED` only when `counts.exceptions` = 0. | Pinned list price per row; held plan list price from its current PUBLISHED version |

Discrepancy codes (closed set): `ENTITLEMENT_MISSING`, `PLAN_VERSION_INTEGRITY` (checksum or format failure: `planVersionTerms` fails closed), `PLAN_VERSION_NOT_PINNABLE`, `PRICE_NOT_USD`, `SELF_SERVICE_WITHOUT_PROVIDER_LINK`, `MANUAL_PROVIDER_LINKED`.

**Money rules (C6 HALT rule; A0-C6):**
- The only monetary figure is a plan version's `list_price_minor` per `billing_interval`, in **USD** (the checksum-verified content).
- A non-USD, missing or contract-priced price is withheld (`list_price: null`) with `unpriced_reason`. It is never converted or defaulted.
- No sum, total, MRR/ARR, amount owed, proration or discount is computed.
- Money appears only on the three Finance routes.

**Routes** (platform-admin, `PlatformCommercialFinanceController`, all `@RequireScopes('platform:billing:read')`, platform tier only, read-only):
- `GET /platform/commercial/finance/renewals?within_days=1..365&tenant_id&product_key`
- `GET /platform/commercial/finance/outstanding-payments?tenant_id&product_key`
- `GET /platform/commercial/finance/reconciliation-report?tenant_id&product_key`

**Scope (C6-D1, recorded):** `platform:billing:read`, per the A1 §4.1 matrix (`:118`). Allowed: platform_owner, finance_admin, commercial_ops, support_admin, read_only_auditor. Refused: catalog_manager, super_admin.

## 3. Reconciliation output (Stripe test mode; real Postgres 17; fake Stripe, no network, no key)

Produced by `C6-REC-1`, `libs/subscription/src/tests/ccp-c6-finance-report.integration.spec.ts`, through `formatReconciliationReport`. Tenant and subscription ids are replaced by the fixture letters.

```
[reconciliation] as_of=2026-10-26T12:00:00.000Z provider_mode=test currency=USD status=EXCEPTIONS exceptions=4
[reconciliation] open subscriptions: 5 by_source={"MANUAL":3,"SELF_SERVICE":2} by_status={"ACTIVE":4,"PAST_DUE":1}
[reconciliation] with discrepancy: 2 {"ENTITLEMENT_MISSING":2}
[reconciliation]   sub=SB tenant=B sign SELF_SERVICE ACTIVE plan=aramo-sign-standard-business-v1 v1 price=USD 20.00/MONTH entitlement=core+sign discrepancies=none
[reconciliation]   sub=SA tenant=A sign MANUAL ACTIVE plan=aramo-sign-included-v1 v1 price=unpriced(NO_LIST_PRICE) entitlement=core+sign discrepancies=none
[reconciliation]   sub=SG tenant=G sign MANUAL ACTIVE plan=aramo-sign-standard-business-v1 v1 price=USD 20.00/MONTH entitlement=- missing=core+sign discrepancies=ENTITLEMENT_MISSING
[reconciliation]   sub=SC tenant=C sign SELF_SERVICE PAST_DUE plan=aramo-sign-standard-business-v1 v1 price=USD 20.00/MONTH entitlement=core missing=sign discrepancies=ENTITLEMENT_MISSING
[reconciliation]   sub=SD tenant=D sign MANUAL ACTIVE plan=aramo-sign-included-v1 v1 price=unpriced(NO_LIST_PRICE) entitlement=core+sign flags=governed_subscription_open discrepancies=none
[reconciliation] entitled without subscription: 1
[reconciliation]   tenant=E sign capabilities=sign
[reconciliation] held activations (Conv. C-8): 1
[reconciliation]   flag=01a17396-984f-724a-adb4-697829a4801c tenant=D sign provider_sub=sub_01a17396-97f9-72ca-ac8b-4e74795a6390 intent=01a17396-97f9-72ca-ac8b-4e74795a6390 (CREATED) governed=SD (aramo-sign-included-v1) held_plan=aramo-sign-standard-business-v1 held_price=USD 20.00/MONTH commands=0 resolution=UNRESOLVED
[reconciliation] other open flags: 0
[reconciliation] commands: unconfirmed=0 failed=0; inbox: failed=0 unprocessed=0
```

**Fixtures:**
- A: a governed MANUAL row opened through the real request → approve → apply path, with its commitment ending in 20 days.
- B: SELF_SERVICE ACTIVE through checkout plus the provider state, with the signup grant `core` + `sign`.
- C: SELF_SERVICE moved to PAST_DUE by a provider re-sync; only `core` granted.
- D: the A6 hold (checkout, then the governed row, then the provider activation): `IGNORED`, flag raised.
- E: `sign` granted, no subscription.
- G: a raw MANUAL Standard Business row whose commitment lapsed 3 days ago; no entitlement.

`exceptions = 4` = 2 rows with a discrepancy + 1 entitled without subscription + 1 held activation.

**Reproduction.** Every figure is recomputed by raw SQL over the records, independent of the service, and compared for equality:
- renewals: subscription, kind, date and USD price;
- outstanding: subscription, status, grace state and price;
- reconciliation: subscription, tenant, source, status and missing capabilities per row, plus the `by_source` counts, the entitled-without-subscription tenants and the held activations (flag, tenant, provider subscription, intent status, governed row, held price).

| Test | Output |
|---|---|
| **C6-REN-1** renewals reproduce the oracle | equal at horizons 90 and 10. A: `COMMITMENT_END`, `days_until` 20, `list_price` null, `NO_LIST_PRICE`. G: `days_until` −3, `lapsed`, USD 2000/MONTH. B and C: `PERIOD_END` 2026-11-25T00:00:00.000Z. Sources MANUAL / SELF_SERVICE only. `within_days` 0 → `RangeError` |
| **C6-OUT-1** outstanding reproduces the oracle | C: `PAST_DUE`, `IN_GRACE`, `amount_due` null, `INVOICE_READ_NOT_DELIVERED`, USD 2000. At as_of + 8 days: `GRACE_ENDED` (7-day grace) |
| **C6-REC-1** reconciliation reproduces records and effective entitlements | per-row equality with the oracle; `open_subscriptions` 5; `by_source` equal and summing to 5; orphan tenants equal (`[E]`); `discrepancies` = `{ENTITLEMENT_MISSING: 2}`; `exceptions` = the sum of its parts |
| **C6-HELD-1** held activations listed (C-8) | equal to the oracle. 1 held activation: intent `CREATED`, governed row D (`aramo-sign-included-v1`), held plan Standard Business USD 2000/MONTH from `CURRENT_PUBLISHED_PLAN_VERSION`, `UNRESOLVED`. The governed row reconciles and carries `governed_subscription_open` |
| **C6-HELD-2** pending resolution shown, never faked (C-9, C-23) | An approved CONVERSION plus a dispatched cancel command → `resolution: PENDING_PROVIDER`, command `PENDING_PROVIDER` listed. After the provider-confirmed end (re-fetch), the flag is resolved and the report no longer lists it; 0 unconfirmed commands; the governed row is still the only open row |
| **C6-FILTER-1** isolation | the tenant and product filters scope every section; no other tenant appears |
| **C6-RO-1** read-only | SHA-256 of every read table (subscription rows, versions, flags, intents, commands, inbox, events, commercial audit, entitlements) unchanged across all 3 reports; a write inside the report transaction raises "read-only transaction" |
| **C6-USD-1** USD only | an EUR-priced fixture version (test database only): `list_price` null, `NON_USD_CURRENCY`, discrepancy `PRICE_NOT_USD`; the string "EUR" never appears in the report |
| C6-U-1…U-4 (unit) | the USD price passes through exactly; contract-priced / missing / non-USD / unverified prices are withheld with a reason; `days_until` rounding (20, 1, 0, −0 → 0, −3); grace state |

## 4. Per-role, dashboard, Pact and gates

| Run | Result |
|---|---|
| `apps/platform-admin/src/tests/ccp-c6-finance-authorization.spec.ts` (real JwtAuthGuard + RolesGuard) | **17 / 17**. All 3 routes: allowed 200 for platform_owner, finance_admin, commercial_ops, support_admin and read_only_auditor (USD figure, held activation, ISO dates). Refused 403 `missing_scopes [platform:billing:read]` for catalog_manager and super_admin, with no monetary field in the body. 401 with no token; 403 for a tenant-tier token. Filters typed. 7 × 400 `VALIDATION_ERROR`. |
| **Dashboard no-money** `apps/platform-web/src/dashboard/DashboardView.no-money.spec.tsx` | **3 / 3**. C6-DASH-1: the rendered dashboard has no `$n`, USD/EUR/GBP, MRR, ARR, revenue, price or amount text. C6-DASH-2: the dashboard contract and view source carry no monetary field. C6-DASH-3: no console source calls `/platform/commercial/finance` (0 callers). |
| Consumer `platform-web-consumer` (run serially, `--maxWorkers=1`) | **57 interactions**, 57 / 57 tests (C1 recorded 45; +12): 3 allowed 200 (renewals by finance_admin, outstanding by commercial_ops, reconciliation by read_only_auditor), plus 3 × catalog_manager 403, 3 × super_admin 403 and 3 × tenant tier 403 (GATE_ROUTES). |
| Provider `verify-platform-admin` (`ARAMO_RUN_PACT_PROVIDER=1`) | **2 / 2 provider tests passed**: the CCP route coverage gate (now including the 3 C6 routes) and the verification of all 57 interactions. New state `finance records exist` (3 fixed tenants: a renewal, an outstanding payment, and a held activation). |
| Consumer vs provider counts (A10: reported separately) | 57 consumer interactions; 57 verified by the platform-admin provider |
| `contract-parity:check` | 683 live routes (681 governed), 514 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified (C1: 680 / 678 / 511; +3 / +3 / +3) |
| `openapi:drift-check` | ok (9 files) |
| `redocly lint openapi/platform.yaml` | valid; 2 warnings (equal to the C1 baseline) |
| `orphan-scopes:check` | ok (no change: `platform:billing:read` was already enforced) |
| `tests:integration:check`, `error-codes:check`, `env:passthrough-check` | ok (49 integration roots; no new error code; no new env var) |
| `repo-map:generate` / `repo-map:check` | regenerated (3 files modified); ok. Run under a temporary `GIT_INDEX_FILE` with intent-to-add entries (the real index was not touched), after this record was written |
| ESLint on every changed or new file | 0 errors, 12 warnings: 11 non-null assertions in the C6 integration spec, plus 1 pre-existing unused-disable in `verify-platform-admin.ts:19` |
| `nx run-many -t build typecheck lint` (subscription, platform-admin, aramo-platform-web, platform-web-consumer-pact, aramo-pact-provider; `--skip-nx-cache`) | All passed **except `aramo-pact-provider:typecheck`**: 1 error at `pact/provider/src/verify-sign.ts:850` (TS2322 on a Pact state-handler object). That file is untouched by C6 (TD-C6-11). `subscription:build` failed once against a stale entitlement dist under parallel load (`grantCapabilitiesInTx` missing) and passed on retry with `--skip-nx-cache`. `sign-service:build` passed. Dist markers: `BillingFinanceReportService` in `dist/libs/subscription/src/index.d.ts` and the module; `platform-commercial-finance.controller.js` in `dist/apps/platform-admin` |
| `bash scripts/verify-vocabulary.sh` | OK under the real index and under the temporary index that includes the new files: Tier 1, Tier 2 and front-door are clean. No exemption touched. |

## 5. Tests run and not run

| Suite | Result |
|---|---|
| C6 lib specs (`ARAMO_RUN_INTEGRATION=1`, `--maxWorkers=2`): integration 8 + unit 4 | **12 / 12** (run 3; run 1 failed 1 fixture: a PlanVersion must be inserted as DRAFT and then published, so it was fixed in the spec) |
| `libs/subscription` whole lib, unit mode | 25 files: 10 passed, 15 skipped (integration-gated); 216 passed, 253 skipped |
| `apps/platform-admin` whole app, unit mode | 13 files, **360 / 360** |
| `aramo-platform-web` test target | 32 files, **297 / 297** |
| `apps/sign-service` `ccp-c1-billing-commands.spec`, `billing.spec` (consumers of `SubscriptionModule`) | 2 files, **18 / 18** |
| Pact consumer and provider | see §4 |
| **Not run, HALT H-C6-1:** visual parity at 1440 and 900, axe, keyboard walk for the C6 screens | No screen exists: the pinned design has no Finance screen, so there is nothing to compare. |
| **Not run (instructed):** the full `nx run api`; `verify-api`, `verify-sign`, `verify.ts`, `verify-ti.ts` providers (no apps/api or sign-service returned shape changed) | — |

## 6. Rail items and scopes for B1 (requested; NOT built by C6)

The pinned release has no Finance rail item, so B1 has nothing to link yet. When a design release adds the Finance screens, the proposed entries are:
- **Commercial › Finance:** Renewals, Outstanding payments, Reconciliation.
- Each is visible only with `platform:billing:read` (platform_owner, finance_admin, commercial_ops, support_admin, read_only_auditor; never super_admin or catalog_manager).
- They call the 3 routes in §2.
- Placement and labels are a design decision; C6 does not make it.

The existing B3 and B4 surfaces that the map ties to C6 data are B3 and B4 work: "Commitment ending filter, past-due / in grace" (handoff §11, §5.3) and "Contracts: commitment ending" (§5.5). They can read `renewals` / `outstanding-payments` (money-bearing) or their own non-money fields.

## 7. Recovery and rollback

- Read-only, so there is nothing to compensate. Revert C6-1…C6-4.
- No migration and no data change. The routes have no write path; the reports' transaction is READ ONLY.

## 8. Typed divergences

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| **TD-C6-1** | Scope reading | Money is gated by `platform:billing:read`, the only billing read scope in A1 §4.1. commercial_ops, support_admin and read_only_auditor therefore see list prices. A Finance-only read scope would be a catalog change (a new scope). | **Lead / PO confirmation** |
| **TD-C6-2** | **HALT (UI)** | H-C6-1: no Finance screens in CCP-UI v1.0 (pre-execution §2.1). No screen, rail item, parity baseline, axe or keyboard test was produced. The brief's "Finance screens section (renewals, outstanding payments)" does not exist in the pinned handoff. | **Design release needed** (v1.1 or an amendment with a new manifest), then a C6-UI follow-up |
| TD-C6-3 | Data gap | No amount owed: invoice and payment status is C3 (NOT DELIVERED). Outstanding items show the recurring list price plus `amount_due: null` (`INVOICE_READ_NOT_DELIVERED`). | Until C3 |
| TD-C6-4 | Scope boundary | No monetary totals or aggregates (MRR, ARR or a sum of prices); counts only. Aggregates are D2. | Recorded |
| TD-C6-5 | Source choice | A held activation's price is the held plan's **current PUBLISHED** version. No version is pinned before activation, and the flag stores no provider price. | Recorded |
| TD-C6-6 | Merge-forward | Revoked entitlements are excluded when `entitlement."TenantEntitlement".revoked_at` exists (detected at runtime from `information_schema`), so A7's revoke is honoured without a code change. | For the lead at the A7 merge |
| TD-C6-7 | Rule reading | Expected capabilities per open row = `PRODUCT_CAPABILITIES[product]` (`sign → core + sign`) for every source. `core` is never counted as "entitled without subscription" (it is shared). | Recorded |
| TD-C6-8 | Data gap | The webhook inbox has no tenant, so its counts are platform-wide even under a `tenant_id` filter. | Recorded |
| TD-C6-9 | Scale | No pagination: each report is a complete snapshot (bounded by the open subscriptions), which reconciliation needs. | Revisit at D3 / scale |
| TD-C6-10 | Rule reading | Renewal dates are `commitment_end` (any source) and the provider `current_period_end` (provider-linked rows only). MANUAL monthly period boundaries (from `period_anchor`) are not renewals. | Recorded |
| TD-C6-11 | Pre-existing | `aramo-pact-provider:typecheck` fails at `pact/provider/src/verify-sign.ts:850` (TS2322 on a state-handler object). The file is untouched by C6. | For the owner of `verify-sign.ts` (A6 added that state) |
| TD-C6-12 | Record gap | TD-B1-2 ("Dashboard stays role-scoped, no money") is not in this worktree's `doc/ccp/decisions.md` (baseline `6b5051a8`). C6-DASH-1…3 enforce the same rule from A1-4a. | For the lead (B1 merge) |
| TD-C6-13 | Test-only | Fixtures set `commitment_end` by raw UPDATE, and the Pact provider state writes raw rows: the provider harness has no billing key, so no provider activation can run there. The lib spec builds B, C and D through the real lifecycle and A6 hold. | Recorded |
| TD-C6-14 | Read edge | Tenant names come from a read-only `LEFT JOIN identity."Tenant"` (A6 already reads `identity."Tenant"` in the subscription lib). No new nx edge; no write. | Recorded |
| TD-C6-15 | Merge note | Expected overlap with parallel slices: `libs/subscription/src/index.ts`, `subscription.module.ts`, `openapi/platform.yaml`, `ci/config/api-surface-manifest.json`, `platform.module.ts`, the platform-web consumer and `verify-platform-admin.ts` (A10 `GATE_ROUTES`), `doc/generated/repo-map.*` | For the lead |

No correction-1 trigger (PBD §2.4) arose for the backend part.

## 9. Vocabulary result

`bash scripts/verify-vocabulary.sh`: OK (Tier 1, Tier 2 and front-door retirement clean), under the real index and under a temporary index that includes the C6 files. No exemption allowlist was touched; the Stripe wire exemption (`stripe-wire.ts`) is unchanged and not used.
