# CCP-C3 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.2 C3 row (`:93`). Governing instruments: the Charter (§3 `:92` "Aramo SHALL mirror status only"; §4 L5 `:118`), PLATFORM-UX-1 Amendment A1 (A1-4a `:68`) and the CCP A1 matrix (`:118`, `:317`).

| | |
|---|---|
| **Slice** | CCP-C3: read-through invoice and payment status |
| **Branch / baseline** | `wip/ccp-c3` at `6b5051a8` (CCP-C1 head) |
| **Pre-execution record** | `doc/ccp/slices/CCP-C3-pre-execution.md` (choices C3-D0…C3-D7) |
| **Local commit SHAs** | **pending (lead commits).** The executor committed and pushed nothing. |
| **Delivered status (PBD §10)** | **NOT DELIVERED.** The external dependency `STRIPE_PORTAL_CONFIGURATION` is not verified. The code is built in Stripe test mode with designed disabled states. See §3. |
| **HALT conditions hit** | **None.** No new vocabulary exemption was needed. Every Stripe identifier that trips the gate stays in `stripe-wire.ts`, the existing exemption; its allowlist entry in `scripts/verify-vocabulary.sh` is unchanged. No write to Stripe exists on the C3 path. |
| **UI** | **Backend only (C3-D0).** The pinned handoff (manifest `12aa308b…`, 5 of 5 entries checked OK) maps the one C3 row, "Managed in Stripe link-outs", to UI slice **B3** (`handoff :502`). No `apps/platform-web` file, rail or shell was touched. |
| **Migration** | **None.** The reserved `20261026070000_ccp_c3_*` is unused. `pact/provider/src/verify-api.ts` and `verify-sign.ts` are unchanged, because no apps/api or sign-service shape changed. |

## 1. Commit map (proposed; SHAs pending, lead commits)

| # | Proposed commit | Files |
|---|---|---|
| C3-0 | `CCP-C3: pre-execution check` | `doc/ccp/slices/CCP-C3-pre-execution.md` (new) |
| C3-1 | `CCP-C3: read-only provider port, Stripe read translators and the GET-only read adapter` | `libs/subscription/src/lib/billing/billing-provider.port.ts`; `stripe-wire.ts`; `stripe-billing-read.adapter.ts` (new) |
| C3-2 | `CCP-C3: read-through billing status service (designed disabled states; tenant and product isolation); module wiring` | `libs/subscription/src/lib/billing/billing-status-read.service.ts` (new); `subscription.module.ts`; `src/index.ts` |
| C3-3 | `CCP-C3: read-only billing-status routes, OpenAPI and gates` | `apps/platform-admin/src/app/platform/platform-commercial-billing-status.controller.ts`, `dto/commercial-billing-status.dto.ts` (new); `platform.module.ts`; `openapi/platform.yaml`; `ci/config/api-surface-manifest.json`; `ci/scripts/verify-orphan-scopes.ts` (comment only) |
| C3-4 | `CCP-C3: tests (read-only proof, wire contract, real-Postgres no-write, per-role routes)` | `libs/subscription/src/tests/ccp-c3-billing-read.spec.ts`, `ccp-c3-billing-status.integration.spec.ts`, `apps/platform-admin/src/tests/ccp-c3-billing-status-authorization.spec.ts` (new); `libs/subscription/src/tests/stripe-wire.spec.ts` |
| C3-5 | `CCP-C3: Pact — billing-status routes (platform-web / verify-platform-admin)` | `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts`; `pact/provider/src/verify-platform-admin.ts` |
| C3-6 | `CCP-C3: acceptance evidence` + `CCP-C3: regenerate repo map` | `doc/ccp/slices/CCP-C3-acceptance.md` (new); `doc/generated/repo-map.{coupling,files,projects}.json` |

Totals: **9 new files** (8 plus this record), **14 modified files**. `git diff --shortstat` over the modified files: 14 files, 1135 insertions, 6 deletions (after the final repo-map regeneration). The 8 new files other than this record total 1482 lines.

**Unchanged:** every migration and `schema.prisma`; `stripe-billing.provider.ts` (the write-capable adapter); `subscription-lifecycle.service.ts`; every existing `BillingProviderPort` / `BillingProviderCommandPort` fake; `scripts/verify-vocabulary.sh`; `docker-compose.prod.yml`, `.env.prod.example` and `.env.example`; `doc/ccp/decisions.md`; and all `apps/platform-web` code.

## 2. The read-only proof (PBD C3 mandatory test "Adapter is read-only")

The proof is structural, at the source level, at the HTTP level and at the database level.

| Layer | Test ID | Output |
|---|---|---|
| **Separate class, no mutating method reachable** | C3-RO-1 | The `StripeBillingReadAdapter` method set across its whole prototype chain is exactly `isConfigured, mode, retrieveSubscription, listSubscriptionInvoices, retrievePortalConfiguration` plus the private helpers `secretKey, base, read`. None of the 5 mutating provider operations (`upsertBillingAccount`, `createCheckoutSession`, `createPortalSession`, `cancelSubscription`, `expireCheckoutSession`) is present, and neither are `verifyWebhook` or `retrieveCheckoutSession`. It is not an instance of `StripeBillingProvider`. The control check confirms that the write-capable adapter does hold all 5. |
| **Source: GET only** | C3-RO-2 | The adapter source (comments excluded) has exactly one `method:` literal, `'GET'`. It has no `POST`, `PUT`, `PATCH` or `DELETE` literal, no `body`, no idempotency key and no reference to `StripeBillingProvider`. It has exactly 1 `fetch(` call site and 3 `this.read(` call sites. |
| **Source: the service depends on the read port only, and writes nothing** | C3-RO-3 | `@Inject(BILLING_PROVIDER_READ_PORT)`. There is no reference to `BILLING_PROVIDER_PORT`, `BILLING_PROVIDER_COMMAND_PORT` or `StripeBillingProvider`. There is no Prisma create/update/upsert/delete, `$executeRaw`, `$queryRaw` or `$transaction`. There are exactly 2 `tenantSubscription.findFirst` reads. |
| **DI binding** | C3-RO-4 | In `SubscriptionModule` and `.forRoot()`, the read port resolves to a `StripeBillingReadAdapter`. It is distinct from the provider and command port instances, has no mutating method, and is the instance injected into `BillingStatusReadService`. |
| **Reachable surface at run time** | C3-RO-5 | A proxy records every property the service touches on its reader across 6 scenarios (available, mismatch, provider down, portal down, portal ok, live mode). The touched set is exactly `isConfigured, listSubscriptionInvoices, mode, provider, retrievePortalConfiguration, retrieveSubscription`. |
| **HTTP: every request is GET, with no body** | C3-W-4, C3-W-5 | Against a stand-in (with `sk_test_` and no network), every request across subscription read, invoice list, portal configuration, 404, 429 and 400 is `GET` with `body` undefined and no `idempotency-key` or `content-type` header. The paths are the subscription read (account expanded, through `wireSubscriptionQuery`), `/v1/invoices?subscription=sub_1&limit=5` and `/v1/billing_portal/configurations/bpc_terms`. |
| **Database: nothing is written** | C3-I-1, C3-I-2, C3-I-4 | A per-table `count + md5` fingerprint of **every** base table in the `subscription`, `entitlement` and `identity` schemas (more than 20 tables, asserted) is identical before and after: an AVAILABLE read plus a portal read (C3-I-1); a MANUAL-row read and an unknown-tenant read (C3-I-2; only `identity.Tenant` differs, from the test's own fixture insert); and a provider-failure read (C3-I-4). |
| **Routes: GET only** | C3-R-5 | POST, PUT, PATCH and DELETE on both paths return 404 for platform_owner, and the service is never reached. |
| (all provider calls in the integration spec) | C3-I-5 | Every recorded provider operation is a member of `STRIPE_READ_ADAPTER_METHODS`. |

## 3. Delivered / not-delivered (PBD §10)

| Item | Status | Evidence |
|---|---|---|
| **C3 portal configuration** (`STRIPE_PORTAL_CONFIGURATION`) | **NOT DELIVERED.** The external decision is not verified. | Release D18 (`doc/runbooks/RELEASE-sign-standalone-billing.md:141`) requires a portal configuration whose cancellation settings match the approved annual terms. No verification is recorded. `GET /platform/commercial/billing-portal-configuration` reports provider facts only (`NOT_CONFIGURED` / `NOT_FOUND` / `INACTIVE` / `ACTIVE` plus feature flags). An `ACTIVE` result is **not** the §10 verification, and the route never claims it (C3-S-5 asserts that no `verified` field exists). |
| Read-through invoice and payment status | Built in **Stripe test mode** with designed disabled states | §4 |
| Live billing (any slice) | NOT DELIVERED (Stripe live account and keys) | A live key returns `LIVE_MODE_HELD` (TD-C3-3) |

## 4. Tests and gates (no live key, no network to Stripe)

| Run | Result |
|---|---|
| `libs/subscription/src/tests/stripe-wire.spec.ts` (exempt boundary contract spec) | **13 / 13** (8 existing + 5 new). C3-W-1: invoice translation for the pinned and newer API shapes, with no vendor key left after translation, and malformed fields falling to null or 0. C3-W-2: portal configuration translation. C3-W-3: invoices are listed by subscription (never by account), limit clamped to 1..100, and the path is encoded. C3-W-4 and C3-W-5: the adapter is GET-only (above); 404 returns null or `[]`; 4xx is not retryable; 429 is retryable; no key means unconfigured; `rk_live_` means live. |
| `libs/subscription/src/tests/ccp-c3-billing-read.spec.ts` | **11 / 11**: C3-RO-1…RO-5 (above); C3-S-1 AVAILABLE (amounts mirrored, no totals); C3-S-2 designed states (BILLING_UNAVAILABLE and LIVE_MODE_HELD make 0 DB reads; NO_PROVIDER_SUBSCRIPTION; PROVIDER_UNAVAILABLE carries the detail); C3-S-3 tenant isolation (6 mismatch cases → `TENANT_MISMATCH` with no provider data); C3-S-4 open row preferred, else the latest ended row, plus the product, limit and refusals; C3-S-5 portal states; C3-U-1 the payment-state table (DRAFT, PAID, UNCOLLECTIBLE, VOID, UNKNOWN, DUE, open-with-0-remaining → PAID, PAYMENT_FAILED, OVERDUE, and due-exactly-now → DUE) |
| `libs/subscription/src/tests/ccp-c3-billing-status.integration.spec.ts` (`ARAMO_RUN_INTEGRATION=1`, real Postgres 17) | **5 / 5**, run twice: C3-I-1…I-5. I-1: AVAILABLE on a real SELF_SERVICE row, `['OVERDUE','PAID']`, DB byte-identical. I-2: MANUAL → `NO_PROVIDER_SUBSCRIPTION` with 0 provider calls. I-3: two tenants each read only their own subscription; a provider row stamped for the other tenant → `TENANT_MISMATCH`. I-4: an open row, then the ended row after `ended_at`, then provider down → `PROVIDER_UNAVAILABLE` with the DB unchanged. I-5: read-port operations only. |
| `apps/platform-admin/src/tests/ccp-c3-billing-status-authorization.spec.ts` (real JwtAuthGuard + RolesGuard) | **19 / 19**. C3-R-0: matrix check. C3-R-1: **allowed 200** for platform_owner, finance_admin, commercial_ops, support_admin and read_only_auditor, on both routes. C3-R-2: **refused 403** `missing_scopes [platform:billing:read]` for catalog_manager and super_admin, with no service reached. C3-R-3: 401 with no token; 403 for a tenant-tier token. C3-R-4: typed pass-through. C3-R-5: non-GET methods → 404. C3-R-6: 7 × 400 `VALIDATION_ERROR` (product_key missing or `ats`, invoice_limit 0 or 51, an unknown parameter, a non-uuid tenant, any parameter on the portal route). C3-R-7: a service refusal → 400 `invalid_limit`. |
| Whole `libs/subscription` (unit; integration skipped) `--maxWorkers=2` | 10 files passed, 15 skipped; **228 passed**, 250 skipped (478) |
| Whole `apps/platform-admin` `--maxWorkers=2` | **13 files, 362 / 362** |
| `libs/subscription` C1 unit `ccp-c1-stripe-commands.spec.ts` (module wiring C1-U-10, after the C3 module change) | **10 / 10** (in the same run as the 5 C3 integration tests: 15 / 15) |
| Pact consumer `platform-web-consumer` (run serially, `--maxWorkers=1`) | **53 / 53 tests; 53 interactions** (C1 recorded 45; +8): billing-status allowed 200 (finance_admin, AVAILABLE with invoices), portal allowed 200 (read_only_auditor, ACTIVE), catalog_manager 403 × 2, super_admin 403 × 2, tenant tier 403 × 2. |
| Pact provider `verify-platform-admin` (`ARAMO_RUN_PACT_PROVIDER=1`) | **2 / 2 provider tests passed**: the CCP route coverage gate (now including the 2 C3 routes) and the verification of **53 / 53** interactions (0 failures). There are 2 new states: `a tenant with a Stripe-owned subscription and invoices exists` (with `{tenant_id}`) and `a billing portal configuration is set`. The read port is an in-memory reader (TD-C3-8). |
| Consumer vs provider counts (A10: reported separately) | 53 consumer interactions; 53 verified by the platform-admin provider |
| `contract-parity:check` (under a temporary `GIT_INDEX_FILE` with intent-to-add entries; real index untouched) | 682 live routes (680 governed), 513 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified (C1: 680 / 678 / 511; +2 / +2 / +2) |
| `openapi:drift-check` | ok (9 files) |
| `redocly lint openapi/platform.yaml` | valid; 2 warnings (equal to the C1 baseline) |
| `orphan-scopes:check` | ok (no classification change; `platform:billing:read` was already literally enforced by C1, and C3's routes are the "billing status read routes (C3/C4)" its A1 reservation named) |
| `env:passthrough-check` | ok (109 passthrough + 3 required-interp + 2 guarded; no env change) |
| `error-codes:check`, `tests:integration:check` | ok (no new error code; 49 integration roots) |
| `repo-map:generate` / `repo-map:check` (temporary index with intent-to-add entries) | regenerated (3 files modified); ok |
| `nx run-many -t lint build -p subscription platform-admin platform-web-consumer-pact --skip-nx-cache` | 3 projects + 28 dependency tasks succeeded; 0 lint errors (the warnings are all in pre-existing files). Dist markers checked: `BillingStatusReadService` in `dist/libs/subscription/src/index.d.ts` (1), and `dist/apps/platform-admin/src/app/platform/platform-commercial-billing-status.controller.js` present |
| `nx run aramo-pact-provider:lint` | 0 errors; 3 warnings, all pre-existing in `verify-api.ts` |
| ESLint on every changed or new `.ts` | 0 errors; 13 warnings, all on pre-existing lines (2 in `verify-orphan-scopes.ts`, 11 in the existing `stripe-wire.spec.ts` tests) |
| `bash scripts/verify-vocabulary.sh` | **OK**: Tier 1, Tier 2 and front-door are clean. No exemption touched. |
| **Not run** | The full `nx run api` (instructed: no full api run). `verify-sign`, `verify-api`, `verify.ts` and `verify-ti.ts` Pact providers (no sign-service or apps/api shape changed). `apps/platform-web` / `sign-web` (backend-only slice). Any Stripe test-mode call with a real `sk_test_` key: no key is available to the executor, and the PBD row's "Stripe test mode" is met with the test-mode stand-in and the fail-closed live-mode hold (TD-C3-3). |

Run conditions: load averages were 46 to 48 during the runs, and Docker was healthy throughout.

## 5. Money placement and scope (A1-4a; A1 matrix)

- The scope is **`platform:billing:read`** on both routes (C3-D3). The A1 matrix (`:118`) gives it to platform_owner, finance_admin, commercial_ops, support_admin and read_only_auditor, and the A1 schedule reserves it for "Phase C (C3/C4)" (`:317`). This **resolves TD-C1-15**: the routes the reservation named are now the ones that use it.
- Invoice amounts (`*_minor` plus `currency`, mirrored as the provider holds them) appear **only** in `GET …/tenants/{tenant_id}/billing-status`, which serves a dedicated billing (Finance) screen. They appear in no dashboard route and no aggregate, and no figure is totalled or stored (Charter `:92`: no ledger). The portal route carries no money.

## 6. Recovery and rollback

- Read-only: nothing to compensate. **Revert the adapter** (PBD C3 recovery) by reverting C3-1…C3-5. Without the routes, the console shows no billing status, and nothing else depends on them.
- Disable in place: leave `STRIPE_SECRET_KEY` unset for platform-admin, which is the current production state (TD-C3-2). The routes then answer `BILLING_UNAVAILABLE`.

## 7. Typed divergences

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| TD-C3-1 | Scope boundary (UI) | C3 is backend only (C3-D0). For B3's "Managed in Stripe" link-outs, C3 supplies `hosted_url` / `document_url` per invoice (the provider-hosted invoice page). It does **not** supply operator link targets for payment methods, proration or cancellation. The only existing route there is the tenant-owner portal session, a provider POST from sign-service. An operator opening a tenant's portal session would let a platform operator act in Stripe as the tenant, and that is a write. | **Ruling needed for B3:** the operator link-out target (for example, a Stripe Dashboard URL built at the wire boundary, or no link) |
| **TD-C3-2** | Deployment gap | In production, only sign-service receives the Stripe env (`docker-compose.prod.yml:467-470`, `:498`). platform-admin has no key and no `STRIPE_PORTAL_CONFIGURATION`, so both routes answer `BILLING_UNAVAILABLE` there. No compose or env change was made. Giving platform-admin the full secret key would hand a write-capable key to the console service. | **Security / release decision.** Recommended: a Stripe **restricted read-only key** for platform-admin. The adapter accepts `rk_` keys, and `rk_live_` counts as live. |
| TD-C3-3 | Fail-closed choice | A live-mode key gives `LIVE_MODE_HELD`, and no provider read is made (same rule as TD-C1-3; PBD `:87`: Phase C runs in test mode) | **For the PO at live release** (lift together with TD-C1-3) |
| TD-C3-4 | External dependency | Code cannot verify the §10 decision. `ACTIVE` is reported as a provider fact only. | C3 stays **NOT DELIVERED** until a person records the D18 verification |
| TD-C3-5 | Scope reading | `platform:billing:read` exposes invoice amounts to commercial_ops, support_admin and read_only_auditor as well as finance_admin and platform_owner. A1-4a governs **where** money appears (Finance screens, never the dashboard), not which roles see it. Narrowing it would be a scope-catalog change. | **Confirm** (Architect) |
| TD-C3-6 | Design choice | The Stripe read translators (paths, list query, invoice and portal-configuration fields) were added to `stripe-wire.ts` as pure translation, under the existing exemption. No new exemption was created. The read adapter reuses the pure `stripeSubscriptionState` and `STRIPE_API_VERSION` from `stripe-billing.provider.ts`, but never its class. | Recorded |
| TD-C3-7 | Scope | Payment methods and card data are **not** read (Charter `:92`). "Payment status" is the provider subscription status plus a per-invoice `payment_state` derived only from the provider's status, `amount_remaining`, `due_date` and `attempt_count`. No dunning schedule is modelled beyond `next_attempt_at`. | Recorded |
| TD-C3-8 | Test design | The Pact provider overrides `BILLING_PROVIDER_READ_PORT` with an in-memory, Aramo-shaped reader, so there is no Stripe and no vendor JSON in a gate-enforced file. The GET-only adapter itself is proved in `stripe-wire.spec.ts` (C3-W-4/5) and `ccp-c3-billing-read.spec.ts`. | Recorded |
| TD-C3-9 | Choice | An unknown tenant id answers 200 `NO_PROVIDER_SUBSCRIPTION`, not 404 (no cross-lib tenant lookup) | Recorded |
| TD-C3-10 | Choice | `PROVIDER_UNAVAILABLE.detail` carries the provider's error message, truncated to 300 characters, to the operator | Recorded |
| TD-C3-11 | Choice | `invoice_limit` defaults to 12, maximum 50, newest first. There is no cursor (Stripe paging is not exposed). | Recorded |
| TD-C3-12 | Merge note | Expected overlap with the parallel slices: `libs/subscription/src/index.ts`, `subscription.module.ts`, `billing-provider.port.ts`, `stripe-wire.ts`, `stripe-wire.spec.ts`, `openapi/platform.yaml`, `api-surface-manifest.json`, `verify-orphan-scopes.ts` (comment), `platform.module.ts`, the platform-web consumer (`Coverage — CCP routes (13)`), `verify-platform-admin.ts` (`overrideProvider` on the AppModule compile) and `doc/generated/repo-map.*` | For the lead |

No correction-1 trigger (PBD §2.4) arose.

## 8. Vocabulary result

`bash scripts/verify-vocabulary.sh`: **OK.** Tier 1, Tier 2 and front-door retirement are clean. No exemption allowlist was touched. The Stripe wire exemption (`stripe-wire.ts` + `stripe-wire.spec.ts`) is the only place the new Stripe-shaped identifiers and fixtures appear.
