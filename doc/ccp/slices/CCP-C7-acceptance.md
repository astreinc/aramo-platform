# CCP-C7 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.2 C7 row (`:97`). Governing instruments: MP-A2 N-12 (`:136`), the Row-18 disposition (`:52`, `:61`, `:63`), the Conversion Rule (C-7, C-8, C-15, C-22, C-23), the Charter (`:95`, `:99`, `:116`), and `doc/ccp/decisions.md` (DR-C2-1 `:137`, T8 `:27`, TD-B2-3 `:62`), TD-C1-2 / TD-C1-5 (`CCP-C1-acceptance.md:167`, `:170`).

| | |
|---|---|
| **Slice** | CCP-C7: multi-product self-service |
| **Branch / baseline** | `wip/ccp-c7` at `41a0e3b5` |
| **Pre-execution record** | `doc/ccp/slices/CCP-C7-pre-execution.md` (choices C7-D1…C7-D7) |
| **Status** | **NOT DELIVERED** (PBD §10 `:210`). The external decision "APPROVED legal terms" is not met: `sign.terms_of_service` 0.1.1 is `DRAFT` (`libs/subscription/src/lib/legal/legal-documents.ts:39-41`). Built in Stripe TEST mode with the designed disabled state `SELF_SERVICE_TERMS_NOT_APPROVED`. |
| **Local commit SHAs** | **pending (lead commits).** Nothing committed or pushed by the executor; no `git stash` used. |
| **HALT conditions hit** | **None.** Legal terms missing → designed disabled state (the recorded reading, pre-execution §2). Row-18 trigger does not fire (Sign only). No product without approved pricing. |
| **`guard_commercial_change_request()` / union files** | **Not changed.** No CCP-C7 block is needed in `20261027000000_ccp_guard_union` (no change-request action, state or transition is added). `guard_billing_provider_command()` (C1-only before this slice) is re-created in the slice migration with the C1 body verbatim plus ONE `>>> CCP-C7 self-service origin` block (C7-D5). |
| **Production hold** | Unchanged. No checkout enablement, no public-signup change, no env var or default added, no live key; the C1 dispatcher still refuses a live-mode key (C7-CMD-2). |

## 1. Files (25 paths: 7 new, 18 modified; `git diff --stat` over the 18 modified: 721 insertions, 37 deletions)

| # | Proposed commit | Files |
|---|---|---|
| C7-0 | `CCP-C7: pre-execution check` | `doc/ccp/slices/CCP-C7-pre-execution.md` (new) |
| C7-1 | `CCP-C7: self-service request table; self-service origin on the C1 command (migration + Prisma)` | `libs/subscription/prisma/migrations/20261028030000_ccp_c7_self_service_commands/migration.sql` (new); `libs/subscription/prisma/schema.prisma` (38 → 39 models) |
| C7-2 | `CCP-C7: self-service billing service; C1 enqueue takes the self-service origin` | `libs/subscription/src/lib/billing/self-service-billing.service.ts` (new); `billing-command.service.ts`; `billing-provider-command.ts`; `billing-finance-report.service.ts` (nullable type); `commercial/commercial-conversion.ledger.ts` (null filter); `subscription.module.ts` (both paths); `src/index.ts` |
| C7-3 | `CCP-C7: sign-service self-service routes; OpenAPI` | `apps/sign-service/src/app/billing/esign-billing.controller.ts`; `openapi/sign.yaml`; `apps/sign-web/src/workspace/api.ts` (typed client functions only, no screen) |
| C7-4 | `CCP-C7: platform-admin command read carries the origin; OpenAPI` | `apps/platform-admin/src/app/platform/platform-commercial-billing.controller.ts`; `dto/commercial-billing.dto.ts`; `dto/commercial-finance.dto.ts`; `openapi/platform.yaml` |
| C7-5 | `CCP-C7: tests and compensating SQL` | `libs/subscription/src/tests/ccp-c7-self-service.integration.spec.ts`, `fixtures/ccp-c7-compensating.sql`, `apps/sign-service/src/tests/ccp-c7-self-service.spec.ts` (all new) |
| C7-6 | `CCP-C7: Pact — self-service disabled state (sign-workspace / verify-sign)` | `pact/consumers/sign-workspace-consumer/src/sender-console.consumer.test.ts` |
| C7-7 | `CCP-C7: acceptance evidence` + `regenerate repo map` | `doc/ccp/slices/CCP-C7-acceptance.md` (new); `doc/generated/repo-map.{coupling,files,projects}.json` |

**Unchanged:** every existing migration; `guard_commercial_change_request()` and both union files; `pact/provider/src/verify-api.ts` (no apps/api returned shape changed); `pact/provider/src/verify-sign.ts` and `verify-platform-admin.ts` (existing states suffice); `stripe-wire.ts` (no new Stripe field, no vocabulary exemption); scope catalog, role catalog, super_admin bundle; checkout, portal, webhook and account routes; every env file; `doc/ccp/decisions.md`; the Sign Billing UI.

## 2. Design as implemented

- **Routes** (`v1/sign/billing`, same boundary as checkout: esign consumer + `sign` capability):
  - `GET self-service` — Sign read OR billing authority. Returns the terms state, the open SELF_SERVICE row, `pending_provider` and `pending_changes` (C-23), and per action `{available, reason}` from the SAME evaluator the actions use. `can_manage_billing` only for the owner of a BUSINESS tenant.
  - `POST self-service/cancel` — `sign:billing:manage` only (tenant_owner, ADR-0035 D-3), BUSINESS only. 202 `{request_id, action, status, pending_provider, replayed}`; never reports the change as done.
  - `POST self-service/upgrade` — same authority; every gate, then refused (DR-C7-1). Writes nothing.
- **Gates, in order** (stable codes): `PRODUCT_NOT_SELF_SERVICE` → `SELF_SERVICE_TERMS_NOT_APPROVED` (503 `ESIGN_BILLING_UNAVAILABLE`, reason `self_service_terms_not_approved`: the designed disabled state) → `GOVERNED_SUBSCRIPTION_OPEN` (A6) → `ACTIVATION_PENDING` (A6 hold, tenant copy "Subscription activation pending — contact support") → `CONVERSION_IN_PROGRESS` (any non-terminal CONVERSION, or a RELEASED / CONSUMED release; C2) → `NO_SELF_SERVICE_SUBSCRIPTION` → `PROVIDER_CHANGE_PENDING` → cancel: `ALREADY_CANCELING`, `FINANCIAL_TREATMENT_UNDEFINED` inside a commitment term (DR-C2-1) / upgrade: `PLAN_NOT_AVAILABLE`, then `FINANCIAL_TREATMENT_UNDEFINED`. Existing error codes only (`ESIGN_BILLING_UNAVAILABLE`, `ESIGN_BILLING_CONFLICT`, `VALIDATION_ERROR`); no new error code.
- **Cancel through the C1 durable command:** one local transaction under `billing:<tenant>` records the `SelfServiceBillingRequest` (append-only; names the APPROVED terms `key@version#sha256`) and enqueues `SUBSCRIPTION_CANCEL` `AT_PERIOD_END` with key `aramo-ccp-ss-<request>-cancel_at_period_end` (outbox). Dispatch, retry, FAILED surfacing, live-mode refusal, re-fetch and webhook confirmation are C1's, unchanged. A repeat returns the recorded request.
- **DB backstops (migration `20261028030000`):** request trigger — target must be this tenant's open, provider-linked SELF_SERVICE BASE row of the product with that provider ref, and no open MANUAL row of the product (C-15, A6); UPDATE / DELETE refused; registry CHECK `sign`; terms_ref format CHECK. Command — exactly one origin (trigger + CHECK), derived key per origin (CHECK), a self-service command is SUBSCRIPTION_CANCEL AT_PERIOD_END on its request's tenant / product / target only, `self_service_request_id` immutable; the C1 change-request branch is verbatim.

## 3. Mandatory tests and outputs

`libs/subscription/src/tests/ccp-c7-self-service.integration.spec.ts` (real Postgres 17, fake Stripe, no network, no key): **21 / 21 passed**.

| PBD / instruction test | Test ID | Output |
|---|---|---|
| **Legal-terms disabled state** (shipped registry) | C7-TERMS-1 | view `terms {NOT_APPROVED, sign.terms_of_service, null, null}`; both actions `{available: false, reason: SELF_SERVICE_TERMS_NOT_APPROVED}`; cancel and upgrade refused `SELF_SERVICE_TERMS_NOT_APPROVED`; 0 requests, 0 commands, row byte-identical, 0 provider calls |
| (gate precedence; DB) | C7-TERMS-2 | a governed tenant still reads the terms refusal first; a request row with a non-approved `terms_ref` is refused by `SelfServiceBillingRequest_terms_ref_check` |
| **Durable-command execution in TEST mode** | C7-CMD-1 | `PENDING_PROVIDER` on local commit; 1 request, 1 command `{change_request_id: null, self_service_request_id, SUBSCRIPTION_CANCEL, cancel_at_period_end, aramo-ccp-ss-<id>-cancel_at_period_end, {mode: AT_PERIOD_END}, PENDING, 0}`; row byte-identical; view `pending_provider: true`, cancel `PROVIDER_CHANGE_PENDING`; replay `replayed: true`, still 1 command; dispatch → `PENDING_PROVIDER` attempts 1, exactly 1 provider call with the derived key and `at_period_end: true`, row unchanged; verified webhook through the inbox → `APPLIED`, command `CONFIRMED` (WEBHOOK, event id), row `cancel_at_period_end: true`, `ended_at` null; view `pending_provider: false`, change `CONFIRMED`, cancel `ALREADY_CANCELING` |
| (re-fetch; live hold) | C7-CMD-2 | live-mode key → `skipped: LIVE_MODE`, command `PENDING` attempts 0, 0 calls; test mode → `PENDING_PROVIDER`; `reconcilePending` → `CONFIRMED` (REFETCH), row `cancel_at_period_end: true` |
| (retry / failure) | C7-CMD-3 | 503 once → `RETRY_WAIT` attempts 1 → `PENDING_PROVIDER` attempts 2, the same key on both calls; a 4xx → `FAILED PROVIDER_REFUSED`, listed under `state=FAILED`, view still `pending_provider: true`, DELETE refused |
| **A6 governed-subscription hold** | C7-HOLD-1 | cancel, upgrade and view → `GOVERNED_SUBSCRIPTION_OPEN`; governed row byte-identical; 0 requests; the DB refuses a request naming the MANUAL row |
| (held activation, C-7 / C-8) | C7-HOLD-2 | held (IGNORED, tenant activation state set); cancel refused, 0 commands, governed row byte-identical; the tenant view carries no flag or reason text; a self-service command at the held provider subscription is refused by the DB |
| **C2 interplay** | C7-C2-1 | an open CONVERSION (DRAFT; then APPROVED; then APPLYING) → `CONVERSION_IN_PROGRESS`; after WITHDRAWN the cancel is available again; 0 requests |
| | C7-C2-2 | a pending self-service cancel, then a C2 self-service → governed conversion: the provider-confirmed end confirms BOTH commands (self-service + change-request) in the applying transaction; the conversion is `APPLIED`, open rows `[MANUAL]`; then `GOVERNED_SUBSCRIPTION_OPEN` |
| DR-C2-1 commitment | C7-FIN-1 | inside the term → `FINANCIAL_TREATMENT_UNDEFINED`, 0 requests, view reason the same; at the last commitment period → `PENDING_PROVIDER` |
| DR-C7-1 price change | C7-FIN-2 | the current plan, an unknown plan and the contact-sales plan → `PLAN_NOT_AVAILABLE`; an eligible self-service plan → `FINANCIAL_TREATMENT_UNDEFINED`; view upgrade reason the same; 0 requests, 0 commands, row byte-identical, 0 provider calls |
| **Per-product isolation (MP-A2 N-12)** | C7-ISO-0 | `PRODUCT_KEYS = [sign]`, `SELF_SERVICE_PRODUCTS = [sign]`; both C7 registry CHECKs are `CHECK ((product_key = 'sign'::text))`; the test key appears in no migration |
| | C7-ISO-1 | fixture: one tenant with an open SELF_SERVICE row of the test key AND of `sign` |
| | C7-ISO-2 | the sign view reads the sign row only; ending the other product's row leaves the sign view byte-identical |
| | C7-ISO-3 | the sign cancel writes exactly 1 command `[sign, <sign ref>]`; 0 provider calls on the other ref; other row byte-identical; the code refuses the test key (`not in the product registry`) for view and cancel; the DB refuses a request for the test key (registry CHECK) and a sign request naming the other product's row (trigger) |
| | C7-ISO-4 | the confirmed sign state changes only the sign row; the other row byte-identical |
| DB backstops | C7-DB-1, C7-DB-2 | free-text key refused; IMMEDIATE refused; another target refused; no origin and both origins refused ("exactly one origin"); `self_service_request_id` and the request row immutable; request DELETE refused; the C1 change-request origin keeps its rules (non-approved request, free-text key) |
| Compensating SQL | C7-COMP-1, C7-COMP-2 | refused with C7 rows present (nothing changed); on a fresh full chain it applies with 0 errors, the guard body is byte-equal to C1's, the table and column are gone, `change_request_id` is NOT NULL again; the migration re-applies with 0 errors and the C7 guard body is restored |
| No Stripe call inside a local transaction | C7-TX-1 | probes > 5 across the file; `violations = []` |

`apps/sign-service/src/tests/ccp-c7-self-service.spec.ts`: **6 / 6 passed**:
- **Owner-only billing** C7-S-OWNER-1: a non-owner holding `sign:envelope:read`, `sign:envelope:send`, `tenant:admin:settings` (the sign_admin / tenant_admin shape) and a scope-less principal → 403 `INSUFFICIENT_PERMISSIONS` `billing_manage_scope_missing` on cancel and upgrade; the service is never called.
- C7-S-OWNER-2: the owner reaches the service with the verified tenant, `sign` and the acting user; the answer is pending-provider only; a missing `plan_key` → 400.
- C7-S-OWNER-3: the view needs Sign read or billing authority (`tenant:admin:settings` alone → 403 `billing_read_scope_missing`); `can_manage_billing` true only for the BUSINESS owner.
- C7-S-BIZ-1: PERSONAL refused before the service.
- C7-S-HTTP-1: all 10 refusals map to a stable code, status and lower-case reason; the tenant copy never carries the internal detail.
- C7-S-HTTP-2: an unbound service → 503.

## 4. Pact, contracts and gates

| Run | Result |
|---|---|
| Pact files | `pact/pacts` deleted, then regenerated from empty: `sign-consumer` 11 tests / 11 interactions, `sign-web-consumer` 6 / 6, `sign-workspace-consumer` 15 / 15 (13 before + 2 C7), `platform-web-consumer` 168 tests / 169 interactions |
| Provider `verify-sign` (`ARAMO_RUN_PACT_PROVIDER=1`) | **1 / 1 provider test passed**, verifying 32 interactions (11 + 6 + 15), including the 2 C7 interactions (GET self-service → every action `SELF_SERVICE_TERMS_NOT_APPROVED`; POST cancel → 503 `self_service_terms_not_approved`) on the existing governed-tenant state |
| Provider `verify-platform-admin` | **2 / 2 provider tests passed** (route coverage gate + all 169 interactions). Touched because the command read now returns `self_service_request_id` and a nullable `change_request_id` |
| Consumer vs provider counts (A10: reported separately) | sign-service: 32 consumer interactions, 32 verified by `verify-sign`; platform-admin: 169 consumer interactions, 169 verified by `verify-platform-admin` |
| `contract-parity:check` (new files intent-to-add in a temporary `GIT_INDEX_FILE`) | 711 live routes (709 governed), 542 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified (+3 routes / +3 ops from this slice) |
| `openapi:drift-check` | ok (9 files) |
| `redocly lint` | `sign.yaml` valid, 17 warnings (baseline 17); `platform.yaml` valid, 2 warnings (baseline 2) |
| `orphan-scopes:check`, `error-codes:check`, `tests:integration:check`, `env:passthrough-check` | ok (no new scope, no new error code, 49 integration roots, 115 passthrough + 3 required-interp + 2 guarded; no new env var) |
| `repo-map:generate` / `repo-map:check` | regenerated (3 files modified); ok (temporary index; real index untouched) |
| `nx run-many -t lint -p subscription sign-service platform-admin` + `aramo-sign-web` | 0 errors (121 / 42 / 92 / 59 warnings, pre-existing kinds); direct ESLint on every changed or new `.ts`: 0 errors, 5 warnings (non-null assertions in the new spec) |
| `nx run-many -t build -p subscription sign-service platform-admin --skip-nx-cache`; `aramo-sign-web` build | succeeded (3 projects + 29 dependency tasks; sign-web + 1); dist markers: `SelfServiceBillingService` in `dist/libs/subscription/src/index.d.ts`, `self-service/cancel` in the dist sign-service controller |
| `bash scripts/verify-vocabulary.sh` | OK: Tier 1, Tier 2 and front-door clean. No exemption allowlist touched; the `stripe-wire.ts` exemption unchanged and unused |

## 5. Tests run and not run

| Suite | Result |
|---|---|
| `libs/subscription`, whole lib, `ARAMO_RUN_INTEGRATION=1`, `--maxWorkers=2` | **49 files, 758 / 758** (includes C1, C2, C3, C6, D3, guard-union GUARD-UNION-1…4, merge-train compensation COMP-0…3, A4 N-12, and C7) |
| `apps/sign-service`: `billing.spec`, `ccp-c1-billing-commands.spec`, `ccp-c7-self-service.spec` | 3 files, 25 / 25 |
| `apps/sign-service` integration: `ccp-a4-ats-sign-consumption` (ATS-triggered Sign consumption golden), `sign-account`, `personal-free`, `sign-legal` | 4 files, 27 / 27 |
| `apps/platform-admin`: `ccp-c1-billing-operations-authorization`, `ccp-c2-conversion-routes.integration`, `ccp-c6-finance-authorization` | 3 files, 38 / 38 |
| `apps/api` `ccp-a4-ats-sign-availability` (applies every lib migration, C7 included) | 1 file, 3 / 3 |
| **Not run:** the full `nx run api` (program rule: one full local run precedes the single push, PBD §8); `verify-api`, `verify.ts`, `verify-ti.ts` (no apps/api, auth or TI shape changed); `apps/platform-web` and `apps/sign-web` unit and visual suites (no UI changed; sign-web lint and build run) | — |

## 6. Regression obligations (PBD §6.1)

- Sign allowance semantics and ATS-triggered Sign consumption: untouched paths; the A4 consumption and availability goldens re-run green (3 / 3 each).
- Tenant role catalog and super_admin bundle: unchanged (no scope or role edit; orphan-scopes ok).
- Existing Stripe self-service behaviour: checkout, portal, webhook, account and the C1 change-request command path are unchanged (C1 / C2 / C6 / D3 specs green in the whole-lib run).

## 7. Recovery and rollback

- Recovery (PBD row): revert the C7 commits; Stripe-side changes stay by durable command. A pending self-service command recovers through C1 (retry, re-fetch, webhook). No self-service change is undone locally: an at-period-end cancel that must be withdrawn is a provider-side change with no ruled path (TD-C7-6).
- **Compensating SQL** (documented, not shipped; never run against production, PBD §7.5): `libs/subscription/src/tests/fixtures/ccp-c7-compensating.sql`, proven by C7-COMP-1 / C7-COMP-2. In one transaction:
  ```sql
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM "subscription"."SelfServiceBillingRequest")
       OR EXISTS (SELECT 1 FROM "subscription"."BillingProviderCommand" WHERE "self_service_request_id" IS NOT NULL) THEN
      RAISE EXCEPTION 'CCP-C7 compensation refused: a self-service billing request or command exists';
    END IF;
  END $$;
  -- 1. CREATE OR REPLACE FUNCTION "subscription"."guard_billing_provider_command"() with the CCP-C1 body
  --    verbatim from 20261026020000_ccp_c1_stripe_command_inbox (in full in the fixture file).
  DROP INDEX "subscription"."BillingProviderCommand_self_service_request_id_step_key";
  ALTER TABLE "subscription"."BillingProviderCommand"
      DROP CONSTRAINT "BillingProviderCommand_self_service_request_id_fkey",
      DROP CONSTRAINT "BillingProviderCommand_idempotency_key_check",
      DROP CONSTRAINT "BillingProviderCommand_origin_check",
      DROP COLUMN "self_service_request_id",
      ALTER COLUMN "change_request_id" SET NOT NULL,
      ADD CONSTRAINT "BillingProviderCommand_idempotency_key_check" CHECK (
          "idempotency_key" = 'aramo-ccp-' || "change_request_id"::text || '-' || "step");
  DROP TRIGGER "self_service_billing_request_guard" ON "subscription"."SelfServiceBillingRequest";
  DROP TABLE "subscription"."SelfServiceBillingRequest";
  DROP FUNCTION "subscription"."guard_self_service_billing_request"();
  ```
  Refused while any C7 row exists (tenant evidence of a Stripe-owned operation is never deleted; export first if a rollback is ever ruled).

## 8. Typed divergences and decision requests

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| **DR-C7-1** | Decision request (fail-closed) | Upgrade is built behind every gate but always refused `FINANCIAL_TREATMENT_UNDEFINED` (`PRICE_CHANGE`). No price-change command kind exists (TD-C1-2); T8 forbids an unruled usage transition; Charter L3 leaves proration to Stripe but the proration mode is still a commercial choice. The PBD row's "upgrade … through Stripe" is therefore **not delivered** even once legal terms are approved. | **PO / Architect:** proration mode and the same-period usage treatment for a self-service price change; then a slice adds the command kind |
| **TD-C7-1** | Design choice (C7-D1) | A tenant-originated `SelfServiceBillingRequest` is the command origin; `BillingProviderCommand.change_request_id` becomes nullable (exactly one origin). C-22's "derived from the change request and step" is read as "derived from the request (change request or self-service request) and step". | **Lead / Architect confirm** the reading |
| TD-C7-2 | Contract change (additive) | `GET /platform/commercial/billing-commands` rows gain `self_service_request_id`; `change_request_id` and the C6 finance `unconfirmed_commands[].change_request_id` become nullable (OpenAPI `[string, 'null']`). Pact `verify-platform-admin` green. | Recorded |
| TD-C7-3 | Scope (C7-D2) | Cancel is AT_PERIOD_END only; inside a commitment term it is refused (DR-C2-1); allowed when the current period reaches `commitment_end` or there is no commitment. Every Standard Business / Professional checkout row carries a 12-month commitment, so in practice the cancel is available only in the last commitment month or on rows without a term. | Recorded (follows DR-C2-1) |
| TD-C7-4 | UI (C7-D6) | No tenant-side design pins a cancel or upgrade element; no screen is built. `apps/sign-web/src/workspace/api.ts` gains typed `billingApi.selfService*` functions only (the Pact consumer mirrors them). The existing Billing page still offers the Stripe portal path (C3, NOT DELIVERED). | **Design:** a pinned tenant self-service element before any UI |
| TD-C7-5 | Merge note (C7-D5) | `guard_billing_provider_command()` is re-created by C1 and C7 only; C7 sorts last. If C4 (CREDIT / DISCOUNT widening of `BILLING_COMMAND_ACTIONS`) re-creates it, the integrator must union the C1 branch, the C7 block and C4's change. | For the lead |
| TD-C7-6 | Gap | One request per (subscription, action): a cancel the provider later reverts (e.g. in the Stripe portal) cannot be re-requested on the same row through C7 (the replay returns the recorded request); there is no self-service "resume" action. | Recorded; a resume action needs its own ruling |
| TD-C7-7 | Behaviour observed | C2's self-service → governed apply proceeds while a tenant self-service cancel is pending at the provider; the IMMEDIATE end confirms both commands in one transaction (C7-C2-2). C7 refuses the reverse order (`CONVERSION_IN_PROGRESS`). | **Lead:** whether C2 should refuse while a self-service command is unconfirmed |
| TD-C7-8 | Choice | Self-service refusals write no audit row (no partial state; the tenant request row is the durable record of an accepted action). The commercial audit stream is platform-tier and is not written by tenant actions. | Recorded |
| TD-C7-9 | Test-only | The approved-terms path is exercised by injecting a copy of the shipped registry with `sign.terms_of_service` marked APPROVED (`LEGAL_DOCUMENT_REGISTRY`, test only). No shipped module binds `SELF_SERVICE_PRODUCT_REGISTRY` or an alternate legal registry. | Recorded |

No correction-1 trigger (PBD §2.4) arose. No row-18 trigger (Sign only; authority `sign:billing:manage`, tenant_owner only; R18-2 respected).

## 9. Vocabulary result

`bash scripts/verify-vocabulary.sh`: OK. Tier 1, Tier 2 and front-door retirement are clean. No exemption allowlist was touched; the Stripe wire exemption (`stripe-wire.ts`) is unchanged and not used by C7.
