# CCP-C5 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.2 C5 row (`:95`). Governing instruments: the PBD (`8149cef2…`, §10 `:209`) and the Charter (`82d328eb…`, §3 `:92` "Payments, invoices, tax … | **Stripe** | Aramo SHALL mirror status only").

| | |
|---|---|
| **Slice** | CCP-C5: tax |
| **Branch / baseline** | `wip/ccp-c5` at `41a0e3b5` |
| **Pre-execution record** | `doc/ccp/slices/CCP-C5-pre-execution.md` (choices C5-D0…C5-D4) |
| **Local commit SHAs** | **pending (lead commits).** The executor committed and pushed nothing, and did not stash. |
| **Delivered status (PBD §10)** | **NOT DELIVERED.** The external decision, Stripe Tax registration, is not made or verified. C5 ships the designed disabled state only. See §3. |
| **HALT conditions hit** | **None open.** The row's HALT is "any tax calculation before registration". The baseline had one reachable path to it: an env opt-in on checkout (`stripe-billing.provider.ts:218` at `41a0e3b5`). C5 removes it (TD-C5-1). After C5, no code path can request tax from the provider, and C5-G-1…G-7 prove it. |
| **UI** | **None (C5-D0).** CCP-UI v1.0 (manifest `12aa308b…`, 5 of 5 entries checked OK) lists tax as out of scope (`handoff v1.0.md:33`) and pins no tax state. The state is requested in the v1.1 brief §3.7 (`ARAMO-Claude-Design-Prompt-CCP-UI-v1_1-Finance-Ops-20261025.md:76-78`). No `apps/platform-web` or `apps/sign-web` file was touched. |
| **Migration** | **None.** `pact/provider/src/verify-api.ts` is unchanged (no apps/api shape changed). |

## 1. Commit map (proposed; SHAs pending, lead commits)

| # | Proposed commit | Files |
|---|---|---|
| C5-0 | `CCP-C5: pre-execution check` | `doc/ccp/slices/CCP-C5-pre-execution.md` (new) |
| C5-1 | `CCP-C5: the designed disabled tax state; remove the checkout tax opt-in (no flag)` | `libs/subscription/src/lib/billing/tax-availability.ts` (new); `stripe-billing.provider.ts`; `src/index.ts`; `docker-compose.prod.yml`; `.env.prod.example` |
| C5-2 | `CCP-C5: tax state on the C3, C6, B3 and Sign account reads` | `billing-status-read.service.ts`; `billing-finance-report.service.ts`; `commercial-subscription-read.service.ts`; `subscription-lifecycle.service.ts`; `apps/platform-admin/src/app/platform/dto/commercial-{billing-status,finance,subscriptions}.dto.ts`; `platform-commercial-{billing-status,finance,subscriptions}.controller.ts` |
| C5-3 | `CCP-C5: OpenAPI (TaxAvailability on 5 platform responses and the Sign billing account)` | `openapi/platform.yaml`; `openapi/sign.yaml` |
| C5-4 | `CCP-C5: disabled-state tests and the no-tax-call guard` | `libs/subscription/src/tests/ccp-c5-tax-disabled.spec.ts`, `fixtures/ccp-c5.ts` (new); `ccp-c3-billing-status`, `ccp-c6-finance-report`, `ccp-b3-subscription-read`, `ccp-a4-sign-equality`, `ccp-a5-plan-version` integration specs; `apps/platform-admin/src/tests/ccp-{b3-subscriptions,c3-billing-status,c6-finance}-authorization.spec.ts`; `apps/sign-service/src/tests/billing.spec.ts` |
| C5-5 | `CCP-C5: Pact — tax state (platform-web / sign-workspace)` | `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts`; `pact/consumers/sign-workspace-consumer/src/sender-console.consumer.test.ts` |
| C5-6 | `CCP-C5: acceptance evidence` + `CCP-C5: regenerate repo map` | `doc/ccp/slices/CCP-C5-acceptance.md` (new); `doc/generated/repo-map.{coupling,files,projects}.json` |

Totals: **5 new files** (`tax-availability.ts` 28 lines, `ccp-c5-tax-disabled.spec.ts` 390 lines, `fixtures/ccp-c5.ts` 14 lines, plus the 2 records) and **30 modified files**. `git diff --numstat` over the 30 modified files, after the final repo-map regeneration: 317 insertions, 16 deletions. The 3 repo-map files account for 151 of the insertions, and the 27 source, spec, OpenAPI and config files for 166 (16 deletions).

**Unchanged:** every migration and `schema.prisma`; `stripe-wire.ts` and its vocabulary exemption; `stripe-billing-read.adapter.ts`; `scripts/verify-vocabulary.sh`; `pact/provider/src/*.ts`; `doc/ccp/decisions.md`; the platform Sign tab read (`platform-sign.controller.ts`, C5-D3); and all UI code.

## 2. The designed disabled state

- `taxAvailability()` (`libs/subscription/src/lib/billing/tax-availability.ts`) always returns `{ enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' }`, as a fresh object. It has no import and reads no env, setting or row.
- **There is no flag.** Enabling tax is a future release with its own authorization: it replaces this module and the C5 guard spec on purpose.
- The state is carried, as `tax`, by:

| Read | Route | Schema |
|---|---|---|
| C3 tenant billing status (every `availability`) | `GET /platform/commercial/tenants/{tenant_id}/billing-status` | `TenantBillingStatusResponse.tax` (required) |
| C6 renewals | `GET /platform/commercial/finance/renewals` | `FinanceRenewalsReport.tax` |
| C6 outstanding payments | `GET /platform/commercial/finance/outstanding-payments` | `FinanceOutstandingPaymentsReport.tax` |
| C6 reconciliation report | `GET /platform/commercial/finance/reconciliation-report` | `FinanceReconciliationReport.tax` |
| B3 tenant Commercial overview | `GET /platform/commercial/tenants/{tenant_id}/commercial` | `CommercialTenantOverviewResponse.tax` |
| Tenant Sign billing account | `GET /v1/sign/billing/account` | `BillingAccount.tax` (sign.yaml) |

- The new component `TaxAvailability` (in both specs) pins `enabled: enum [false]` and `reason: enum [STRIPE_TAX_NOT_REGISTERED]`, with `additionalProperties: false`.
- No route, scope, error code or money field was added.

## 3. Delivered / not-delivered (PBD §10)

| Item | Status | Evidence |
|---|---|---|
| **C5 tax** (Stripe Tax registration) | **NOT DELIVERED.** No registration is made or recorded. | Every read reports `tax.enabled = false`, `reason = STRIPE_TAX_NOT_REGISTERED`. No provider request asks for tax (§4). |
| Live tax calculation | Out of scope (row C5 **Out**) | Not built; there is no switch |
| Live billing (any slice) | NOT DELIVERED (Stripe live account and keys) | Unchanged |

## 4. Tests and gates (no live key, no network to Stripe)

| Run | Result |
|---|---|
| `libs/subscription/src/tests/ccp-c5-tax-disabled.spec.ts` | **15 / 15.** Details below. |
| — the state | **C5-T-1:** always disabled, with the registration reason; a fresh object on every read, so a mutated copy changes nothing. **C5-T-2:** with 5 plausible switches set on (`STRIPE_AUTOMATIC_TAX`, `STRIPE_TAX`, `STRIPE_TAX_ENABLED`, `TAX_ENABLED`, `BILLING_TAX_ENABLED`), the state is unchanged. **C5-T-3:** source: the module has no import and no env read; `enabled: true` appears 0 times and `enabled: false` 2 times. **C5-T-4:** no env flag: no billing source (the subscription lib and the sign-service and platform-admin apps) reads an env name with a TAX segment, and `docker-compose.prod.yml`, `.env.prod.example` and `.env.example` name none. |
| — the no-tax-call guard, by source scan | **C5-G-1:** the scan covers every provider client. The only sources that read `STRIPE_SECRET_KEY`, and the only sources in `libs/` and `apps/` that name the provider API host, are the two Stripe adapters. **C5-G-2:** no billing source names a tax request parameter or endpoint (automatic tax, rates, ids, id collection, behaviour, code, exemption, the tax API). There is exactly 1 allowlisted line: the organization's own registration-number profile field in `sign-signup.service.ts` (an identity column; C5-G-7). |
| — the no-tax-call guard, by fake provider client | `fetch` is stubbed. **C5-G-3:** the guard exercises every provider-calling method of both adapters: 7 on `StripeBillingProvider` and 3 on `StripeBillingReadAdapter`, derived from the prototypes. A new method fails here until it is covered. **C5-G-4:** with the 5 switches on, all branches run (account create and update, checkout with and without an account, portal with and without a configuration, cancel now and at period end, expire, both reads). That is **14 recorded requests** (11 provider + 3 read). None carries a tax path, query key, form key, header or value, and both checkout creates are observed. **C5-G-5:** the matcher fires on real tax parameter shapes, so the guard is not vacuous. **C5-G-6:** the invoice mirror drops every provider tax field, so no tax figure is read. **C5-G-7:** neither the billing-profile port nor the account params carry a tax field, and a `tax_id` passed in details is not sent. |
| — disabled-state tests | **C5-D-1:** the C3 status carries the disabled state on all 6 availabilities. **C5-D-2:** each of the 3 C6 reports carries it, with the provider unconfigured, test or live. **C5-D-3:** the B3 tenant overview carries it, and an unknown tenant is still null. **C5-D-4:** the Sign account read carries it, with billing configured or not. All 4 run with the 5 switches on. |
| `ccp-c3-billing-status`, `ccp-c6-finance-report`, `ccp-b3-subscription-read` integration (`ARAMO_RUN_INTEGRATION=1`, real Postgres 17) | Each asserts `tax` equals the disabled state on a real read (1 + 3 + 1 assertions added) |
| Targeted integration, 12 files (`ARAMO_RUN_INTEGRATION=1`, `--maxWorkers=2`): c3, c6, b3, subscription-lifecycle, a4-sign-equality, a5-plan-version, a11-astre-backfill, a6-hold, a4-product-dimension, a6-apply, commercial-catalog-a1, personal-free | **12 files, 179 / 179** (final run). The first run failed 2 tests: the Sign equality goldens (TD-C5-3). |
| Whole `libs/subscription` (unit; integration skipped), `--maxWorkers=2` | 19 files passed, 30 skipped; **318 passed**, 434 skipped (752) |
| Whole `apps/platform-admin`, `--maxWorkers=2` | **23 files, 596 / 596.** The C3, C6 and B3 authorization specs now assert `body.tax` on their allowed-200 paths. |
| Whole `apps/sign-service`, `--maxWorkers=2` | **26 files, 317 / 317.** New: C5-SIGN-1 (the account route passes the state through for the owner and for a Sign reader, with `STRIPE_AUTOMATIC_TAX=1`). |
| Pact consumers, run serially (`--maxWorkers=1`) | `pact/pacts/` did not exist (nothing to delete). platform-web: **168 tests, 169 interactions**. sign-consumer: 11 tests / 11 interactions. sign-web: 6 / 6. sign-workspace: 13 / 13. |
| Pact provider `verify-platform-admin` (`ARAMO_RUN_PACT_PROVIDER=1`) | **2 / 2 provider tests passed; 169 / 169 interactions verified.** Five interactions now carry the exact `tax` object: billing status, renewals, outstanding payments, reconciliation report and the B3 tenant overview. |
| Pact provider `verify-sign` (`ARAMO_RUN_PACT_PROVIDER=1`) | **1 / 1 passed; 30 / 30 interactions verified** (aramo-core 11, sign-web 6, sign-workspace 13). The held-activation billing-account interaction carries `tax`. |
| Consumer vs provider counts (reported separately) | platform-web: 169 consumer interactions, 169 verified by platform-admin. Sign: 30 consumer interactions across 3 pacts, 30 verified by sign-service. |
| `contract-parity:check` (under a temporary `GIT_INDEX_FILE` with intent-to-add entries; real index untouched) | 708 live routes (706 governed), 539 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified (no route added) |
| `openapi:drift-check` | ok (9 files) |
| `redocly lint` | platform.yaml valid, 2 warnings; sign.yaml valid, 17 warnings. Both equal the `41a0e3b5` baseline. |
| `error-codes:check`, `orphan-scopes:check`, `tests:integration:check` | ok, ok, ok (49 integration roots) |
| `env:passthrough-check` | ok (114 passthrough + 3 required-interp + 2 guarded; `STRIPE_AUTOMATIC_TAX` removed from both files consistently) |
| `repo-map:generate` / `repo-map:check` (temporary index) | regenerated (3 files modified); ok |
| `nx run-many -t lint build -p subscription platform-admin sign-service platform-web-consumer-pact sign-workspace-consumer-pact aramo-pact-provider --skip-nx-cache` | 6 projects + 29 dependency tasks succeeded; 0 lint errors. Dist checked: `dist/libs/subscription/src/lib/billing/tax-availability.js` is present, and the built `stripe-billing.provider.js` names the automatic-tax parameter 0 times. |
| ESLint on every changed or new `.ts` | 0 errors. The warning count of every modified file equals its count at `41a0e3b5`; the 3 new `.ts` files have 0 warnings. |
| `bash scripts/verify-vocabulary.sh` | **OK** (Tier 1, Tier 2 and front-door clean; no exemption touched) |
| **Not run** | The full `nx run api` (instructed: targeted only); `verify-api`, `verify.ts` and `verify-ti.ts` (no apps/api shape changed); `apps/platform-web` / `apps/sign-web` suites (no UI change); any call with a real Stripe key (none is available, and C5 makes no provider call of its own). |

## 5. Recovery and rollback

- **Revert** (PBD C5 recovery): revert C5-1…C5-5. This removes the `tax` field from the 6 responses; nothing reads it yet. **Reverting C5-1 restores the `STRIPE_AUTOMATIC_TAX` opt-in.** That is a reachable tax switch before registration, so a revert must keep the provider line removed (or keep the variable unset in prod) until registration is verified.
- No data or migration is involved.

## 6. Typed divergences

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| **TD-C5-1** | Behaviour change (Stripe self-service regression obligation, PBD §6.1) | The pre-existing `STRIPE_AUTOMATIC_TAX=1` opt-in, which made checkout ask Stripe to calculate tax, is **removed**. That covers the code (`stripe-billing.provider.ts:218` at baseline), the sign-service passthrough (`docker-compose.prod.yml:470`) and the operator contract (`.env.prod.example:334`, `:345`). With the default (unset or `0`), checkout requests are byte-identical to the baseline. They differ only where the opt-in was `1`. The row's HALT ("any tax calculation before registration") and the instruction "no env flag that could enable tax" require the removal. | **PO to confirm at the release gate.** The production `/opt/aramo/.env` value of `STRIPE_AUTOMATIC_TAX` was **not** inspected (no production access was authorized). After the next deploy the variable is no longer passed to sign-service, whatever its value. |
| TD-C5-2 | Doc left as is | `doc/runbooks/RELEASE-sign-naming.md:65` still lists `STRIPE_AUTOMATIC_TAX` among the keys that kept their names at the Sign rename. It is a historical release record, so it was not edited. | Recorded |
| **TD-C5-3** | Test adapter change (regression golden) | `ccp-a4-sign-equality.golden.json` was captured on the baseline code `b0e59aa6`, so it predates the additive `account.tax`. The two replay adapters (A4 N-13 and the A5 golden) now pass the account read through `withoutDisabledTax()` (`fixtures/ccp-c5.ts`). It throws unless `tax` is exactly the disabled state, and then strips it. The golden file is **unchanged**, and both specs pass byte for byte. | Recorded (the Sign allowance, capacity and account semantics are unchanged) |
| TD-C5-4 | Scope choice (C5-D3) | The state is not added to the C3 portal-configuration read, the B3 workbench list or the pre-CCP platform Sign tab (`GET /platform/tenants/{id}/sign`). That tab picks its fields explicitly and shows no billing amounts. | Recorded. The v1.1 design can ask for more. |
| TD-C5-5 | UI | No UI (C5-D0). v1.0 pins no tax state, and the v1.1 brief §3.7 requests "Tax not enabled — pending Stripe Tax registration" wherever tax would appear. The display copy is a design decision and is not in the API: the API carries only `enabled` and `reason`. | **Design release v1.1**, then a C5-UI follow-up bound to `tax` |
| TD-C5-6 | Test design (C5-D4) | The guard is test-level (a source scan plus a fake `fetch` client on every adapter method). No runtime filter was added to the adapters, because the design rules out any code path that sends tax. | Recorded |
| TD-C5-7 | Merge note | Expected overlap with parallel slices: `libs/subscription/src/index.ts`, the 4 read services, `stripe-billing.provider.ts`, both OpenAPI files, the 2 Pact consumers, the 3 platform-admin authorization specs, `billing.spec.ts`, `docker-compose.prod.yml`, `.env.prod.example` and `doc/generated/repo-map.*` | For the lead |

No correction-1 trigger (PBD §2.4) arose.

## 7. Vocabulary result

`bash scripts/verify-vocabulary.sh`: **OK.** Tier 1, Tier 2 and front-door retirement are clean, and no exemption allowlist was touched. The new spec names provider accounts `acct_*` and never needs the Stripe wire exemption.
