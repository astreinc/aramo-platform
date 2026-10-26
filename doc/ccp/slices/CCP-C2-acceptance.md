# CCP-C2 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.2 C2 row (`:92`). Governing instruments: the Conversion Rule `Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED` (C-11…C-15, C-21…C-23, C-29), PBD §7.2 (ruling A0-C8), `Aramo-CCP-Charter-Amendment-A1-Apply-Deadline-v1_0-LOCKED` (AD-1…AD-8), and the rulings in the program branch's `doc/ccp/decisions.md` (TD-A6-3 as narrowed by TD-B2-3, T1–T12 and the T8 usage rule, DR-A6-1…4, Q14, NC-5).

| | |
|---|---|
| **Slice** | CCP-C2: governed manual ↔ self-service conversion |
| **Branch / baseline** | `wip/ccp-c2` at `6b5051a8` (C1 on top of A1–A6, A9, A10) |
| **Pre-execution record** | `doc/ccp/slices/CCP-C2-pre-execution.md` (choices C2-D1…C2-D13) |
| **Local commit SHAs** | **pending (lead commits).** Nothing committed or pushed by the executor. |
| **HALT conditions hit** | **None.** No resolution path goes through SQL or a local edit that implies Stripe changed (§2, C2-DB-1, C2-C8-2, C2-GOV-1). No code-vs-instrument contradiction. |
| **`guard_commercial_change_request()`** | Re-created by `20261026060000_ccp_c2_conversion` with the `20261025200000` body **verbatim** (proved by stripping the two delimited blocks and diffing: identical) plus two blocks marked `>>> CCP-C2 CONVERSION branch`. Mirrored in `canTransitionFor` (`COMMERCIAL_C2_CONVERSION_TRANSITIONS`) and A9-U-4. |

## 1. Commit map (proposed; SHAs pending, lead commits)

| # | Proposed commit | Files |
|---|---|---|
| C2-0 | `CCP-C2: pre-execution check` | `doc/ccp/slices/CCP-C2-pre-execution.md` (new) |
| C2-1 | `CCP-C2: conversion release table, CONVERSION guard branch, application CHECK widening (migration + Prisma model)` | `libs/subscription/prisma/migrations/20261026060000_ccp_c2_conversion/migration.sql` (new); `libs/subscription/prisma/schema.prisma` |
| C2-2 | `CCP-C2: the CONVERSION payload schema, release state machine, apply-deadline reader; TS transition mirror` | `libs/subscription/src/lib/commercial/commercial-conversion.ts` (new); `commercial-change-request.ts` |
| C2-3 | `CCP-C2: in-transaction ledger (checkout release, webhook-time conversion, confirmed-end completion) and the requester-only conversion apply` | `libs/subscription/src/lib/commercial/commercial-conversion.ledger.ts`, `commercial-conversion.service.ts` (new); `subscription.module.ts`; `src/index.ts` |
| C2-4 | `CCP-C2: lifecycle honours an approved release at checkout and webhook time; completes self-service → governed on the provider-confirmed end` | `libs/subscription/src/lib/billing/subscription-lifecycle.service.ts` |
| C2-5 | `CCP-C2: convert + conversion routes, OpenAPI and gates` | `apps/platform-admin/src/app/platform/platform-commercial-conversion.controller.ts`, `dto/commercial-conversion.dto.ts` (new); `platform.module.ts`; `openapi/platform.yaml`; `ci/config/api-surface-manifest.json` |
| C2-6 | `CCP-C2: tests (conversion, C8 resolution, TD-C1-4 verification, routes per role) and the shared helper; C1 fixtures made schema-valid; A9-U-4 mirror` | `libs/subscription/src/tests/ccp-c2-conversion.integration.spec.ts`, `ccp-c2-conversion.spec.ts`, `support/ccp-c2.ts`, `apps/platform-admin/src/tests/ccp-c2-conversion-routes.integration.spec.ts` (new); `libs/subscription/src/tests/ccp-c1-command-inbox.integration.spec.ts`; `ccp-a9-role-change.spec.ts` |
| C2-7 | `CCP-C2: Pact — convert and conversion routes (platform-web / verify-platform-admin)` | `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts`; `pact/provider/src/verify-platform-admin.ts` |
| C2-8 | `CCP-C2: acceptance evidence` + `CCP-C2: regenerate repo map` | `doc/ccp/slices/CCP-C2-acceptance.md` (new); `doc/generated/repo-map.{coupling,files,projects}.json` |

Totals: **12 new files, 15 modified files (27 paths)**; `git diff --stat` over the 15 modified files (repo map included): 779 insertions, 28 deletions. **Unchanged:** every existing migration; `pact/provider/src/verify-api.ts` (no apps/api returned shape changed); `pact/provider/src/verify-sign.ts` and every sign-service route shape (the checkout refusal value is still `GOVERNED_SUBSCRIPTION_OPEN`); `stripe-wire.ts` (no new Stripe field, no vocabulary exemption); `commercial-apply.service.ts` (A6-R is changing it in parallel; TD-C2-9); `doc/ccp/decisions.md`; checkout availability, every `STRIPE_*` env and every billing default; no new env var.

## 2. Design as implemented

**One action type, two directions** (C-11; C2-D1): `CONVERSION`, payload `direction` ∈ {`TO_SELF_SERVICE`, `TO_GOVERNED`}, closed key set per direction, validated at create and again at apply. Finance-only chain (TD-A3-2). **Apply is requester-only** (TD-B2-3): actor = `requested_by` and still holding `platform:subscription:request`, then the NC-5 re-check under the snapshotted chain, the payload checksum, and the snapshotted policy's apply deadline when it declares one.

**Governed → self-service (C-12).** The apply is one local transaction under `billing:<tenant>`: `APPROVED → APPLYING → APPLIED`, writing a `CommercialConversionRelease` (`RELEASED`, for the named governed row, the named self-service plan **version**, until the approved `release_expires_at`) and a `CommercialChangeApplication`. Releasing is Aramo-owned and complete on commit (C-21); the governed row is untouched.
- **Checkout:** an unconsumed, unexpired release for exactly that governed row, plan and version admits ONE checkout. It is consumed (`RELEASED → CONSUMED`, bound to the `CheckoutIntent`) in the locked transaction that creates the intent. A second checkout is refused as before (`GOVERNED_SUBSCRIPTION_OPEN`).
- **Webhook:** in the transaction that applies a provider-confirmed, **sending** activation of that checkout (intent still `CREATED`, same plan version, no stranded usage), the governed row is ended (`CANCELED`) and the `SELF_SERVICE` row opened; the release becomes `CONVERTED` (linking request, governed row, self-service row and intent); the hold flag resolves; audited. Anything else falls back to the A6 hold (C-6/C-7), with the reason in the event detail.
- **Held activation** (C-29): with `held_subscription_ref` the release adopts that held provider subscription; after commit the service re-fetches it (outside any transaction) and the applying transaction converts it (`RELEASED → CONVERTED`).

**Self-service → governed (C-13).** The apply checks everything that can be checked before the provider call (target, G3 version, T8, commitment term), then `APPROVED → APPLYING` and enqueues the C1 `SUBSCRIPTION_CANCEL` (`IMMEDIATE`, as C1 built it; key `aramo-ccp-<request>-end_self_service`) in the same transaction (outbox). The request **commits in APPLYING**: the command state is the pending-provider state (C-23; no new request state). The transaction that applies the provider-confirmed end (verified webhook through the inbox, or re-fetch) confirms the command (C1) and then, in that same transaction, opens the governed MANUAL row (same `period_anchor`), grants the product capabilities, writes the application and moves the request to `APPLIED`. A failed re-check there records `APPLY_FAILED` in that transaction (the provider state stays applied); the requester's retry completes it. With `held_subscription_ref`, the held provider subscription is cancelled and the governed row is kept; the confirmed end resolves the flag (C-9).

**DB backstops (migration `20261026060000`):** a CONVERSION may commit in APPLYING only while it has a provider command (deferred trigger); `APPLYING → APPLY_FAILED` is refused while any of its commands is unconfirmed; `APPLIED` requires the matching application plus, for `TO_SELF_SERVICE`, the release, and for `TO_GOVERNED`, only CONFIRMED commands, the governed row open on the applied version, the replaced row ended and the capabilities present. The release table: no DELETE, identity/binding/expiry immutable, consumption only before `expires_at` (CHECK), `CONVERTED` only with the ended governed row and an open provider-linked SELF_SERVICE row, one `RELEASED` per tenant × product, `UNIQUE(intent_id)`.

**Routes** (gate `platform:approval:read`; no new scope): `POST /platform/commercial/change-requests/{id}/convert`, `GET /platform/commercial/change-requests/{id}/conversion` (direction, status, `pending_provider`, release with `effective_state`, commands, application).

## 3. C8 resolution tests (PBD §7.2; Conv. C-29) — IDs and outputs

`libs/subscription/src/tests/ccp-c2-conversion.integration.spec.ts`, real Postgres 17, fake Stripe (no network, no key). Run on this branch state (C1 + C2 on A1–A6, A9, A10). **The program acceptance review must re-run them on the integrated branch state (PBD §7.2: same-PR presence is not evidence).**

| Test | Path | Output |
|---|---|---|
| **C2-C8-1** | held activation → governed → self-service (C-9, C-11, C-12) | Held first (`IGNORED`, open flag `governed_subscription_open`). Approved `TO_SELF_SERVICE` with `held_subscription_ref`, applied by the requester → view `status CONVERTED`, request `APPLIED`, release `CONVERTED` (`held_subscription_ref` = the held ref, `intent_id` = the held checkout). Governed row `ended_at` set; open rows `[SELF_SERVICE]`, its `billing_subscription_ref` = the held ref; open flags `[]`, 1 resolved `governed_subscription_open` flag kept; intent `COMPLETED`; the held `BillingEvent` rows byte-equal (never rewritten); audit includes `COMMERCIAL_CONVERSION_COMPLETED`. |
| **C2-C8-2** | held activation → self-service → governed (C-9, C-11, C-13) | Apply → `status PENDING_PROVIDER`, `pending_provider: true`, request `APPLYING`, 1 command `cancel_held_activation` `IMMEDIATE`. After dispatch the flag is **still open** (local commit is not confirmation). The verified webhook → `IGNORED` (activation ended), open flags `[]`, command `CONFIRMED` with the event id, request `APPLIED`, governed row byte-identical, open rows `[MANUAL]`, 0 SELF_SERVICE rows, view `COMPLETED`. |
| **C2-C8-3** | expired release falls back to the hold (C-12) | Release applied with a 1 h expiry while the post-commit re-fetch fails → `status RELEASED`. At T+2 h the webhook → `IGNORED`, detail names the expired release; release `EXPIRED`; open flags `[governed_subscription_open]`; governed row byte-identical. |

Result: **3 / 3 passed** (in the 21 / 21 run of the file).

## 4. TD-C1-4 verification tests (Architect, 2026-10-25)

| Requirement | Test | Output |
|---|---|---|
| Checkout expiry from authoritative Stripe evidence, never a local timer | **C2-TDC14-1** | A consumed checkout 30 days later, after the release expiry and the sweep: intent `CREATED`, release `CONSUMED`, view `CHECKOUT_STARTED`. A `checkout.session.expired` event whose re-fetch shows the session `open` → `IGNORED "checkout session open"`, intent `CREATED`. The provider re-fetch showing `expired` (`syncCheckoutSession`, no webhook) → `APPLIED "checkout session expired; intent EXPIRED"`. Governed row still open. |
| Event replay is idempotent | **C2-TDC14-2** | The expired-session event redelivered → `DUPLICATE`; intent status, release row JSON and `BillingEvent` count unchanged. A held activation event redelivered → `DUPLICATE`, open flags unchanged. Also C2-REL-1 / C2-GOV-1: the converting event redelivered → `DUPLICATE`. |
| Late / out-of-order webhooks never activate or erase a governed subscription | **C2-TDC14-3**, C2-GOV-1, C2-REL-1 | (a) The released checkout's activation arriving after its session was confirmed expired → `IGNORED`, detail "the checkout is EXPIRED", governed row byte-identical, open rows `[MANUAL]`, release stays `CONSUMED`. (b) A held-activation release past expiry, then a late re-sync → `IGNORED`, governed row byte-identical. (c) After self-service → governed completes, an older event for the ended self-service subscription → `IGNORED "subscription already ended"`, governed row byte-identical (C2-GOV-1). A later event after a conversion re-fetches unchanged state (`ACTIVE -> ACTIVE`), 1 SELF_SERVICE row, no second conversion (C2-REL-1). |
| An expired intent must not bypass the protected MANUAL rule | **C2-TDC14-4** | The release consumed by a checkout is spent: a new checkout → `GOVERNED_SUBSCRIPTION_OPEN`. A fresh release while that checkout is not provider-confirmed expired → `FAILED:RELEASE_CHECKOUT_OPEN` (no local timer decides). After the verified expiry the MANUAL row is byte-identical (never ended without a provider-confirmed paid subscription), a checkout is still refused, and the retry of the fresh request releases (`APPLIED`, attempt 2). |

## 5. PBD C2 mandatory tests and other outputs

| PBD C2 test / obligation | Test ID | Output |
|---|---|---|
| **Release consumed exactly once** | C2-REL-1 | Apply → `RELEASED`, governed row byte-identical; replay `replayed: true`. Checkout → release `CONSUMED` with the intent; governed row still byte-identical; a 2nd checkout → `GOVERNED_SUBSCRIPTION_OPEN`. Activation → `APPLIED "opened ACTIVE (ended MANUAL; conversion <id>)"`; governed `CANCELED`; open rows `[SELF_SERVICE]`; release `CONVERTED`; intent `COMPLETED`; 0 open flags; 9 audit rows in order: CREATED, SUBMITTED, APPROVAL_RECORDED, APPROVED, `COMMERCIAL_CONVERSION_RELEASED`, `COMMERCIAL_CHANGE_REQUEST_APPLIED`, `COMMERCIAL_CONVERSION_RELEASE_CONSUMED`, `COMMERCIAL_SUBSCRIPTION_ENDED`, `COMMERCIAL_CONVERSION_COMPLETED`. |
| **Expired release falls back to the hold** / recovery: an unconsumed release expires | C2-REL-2, C2-C8-3 | At exactly the expiry (half-open) the checkout is refused, view `RELEASE_EXPIRED`; the sweep writes `EXPIRED` once (a 2nd sweep: 0), 1 `COMMERCIAL_CONVERSION_RELEASE_EXPIRED` row; 0 intents; governed row byte-identical. |
| Release binds exactly its checkout | C2-REL-3 | An older checkout's activation stays held (flag), release `RELEASED`; the released checkout `incomplete` first → `IGNORED "checkout INCOMPLETE; the open subscription is kept"`, `[MANUAL]`; then `active` → `[SELF_SERVICE]`, `CONVERTED`. |
| Release apply failures | C2-REL-4 | `FAILED:RELEASE_EXPIRY_PASSED`, `RELEASE_WINDOW_TOO_LONG`, `PLAN_NOT_ASSIGNABLE`, `TARGET_NOT_GOVERNED`, `RELEASE_EXISTS`; each `APPLY_FAILED`, no release row, audited |
| T8 usage | C2-REL-5 | Usage recorded in the new first period under the governed alignment → activation `IGNORED` with "USAGE_TREATMENT_UNDEFINED (CROSS_PERIOD …)", `[MANUAL]`, flag open, release `CONSUMED` |
| **Self-service → governed through a durable command; governed row only after the provider-confirmed end** | C2-GOV-1 | Apply → `PENDING_PROVIDER`, `pending_provider: true`, request `APPLYING`, `application: null`, command `PENDING` (`aramo-ccp-<id>-end_self_service`, `IMMEDIATE`), open rows `[SELF_SERVICE]`. Dispatch → command `PENDING_PROVIDER`, request still `APPLYING`, rows unchanged. Verified webhook → self-service row ended `CANCELED`, command `CONFIRMED` (WEBHOOK, event id), request `APPLIED`, application `CONVERSION` (replaced = the self-service row), governed MANUAL row open with the same `period_anchor`, `[MANUAL]`, entitlements `[core, sign]`; audit: …, `COMMERCIAL_CONVERSION_PENDING_PROVIDER`, `COMMERCIAL_SUBSCRIPTION_OPENED`, `COMMERCIAL_ENTITLEMENT_GRANTED`, `COMMERCIAL_CONVERSION_COMPLETED`, `COMMERCIAL_CHANGE_REQUEST_APPLIED`; view `COMPLETED`. |
| Checks before the provider call | C2-GOV-2 | Commitment term → `FAILED:FINANCIAL_TREATMENT_UNDEFINED`; downgrade → `FAILED:USAGE_TREATMENT_UNDEFINED`; a governed target → `FAILED:TARGET_NOT_SELF_SERVICE`; 0 commands each; 0 provider calls |
| Never APPLIED early; recoverable | C2-GOV-3 | A reservation appearing before the confirmed end → webhook detail `conversion <id> APPLY_FAILED`; self-service row ended, command `CONFIRMED`, request `APPLY_FAILED`, 0 open rows, no application; another commercial_ops retry → `NOT_REQUESTER`; after the reservation settles the requester retry → `COMPLETED`, attempt 2; `cancelSubscription` called exactly once |
| Authority | C2-AUTH-1 | `NOT_REQUESTER` (another commercial_ops), `REQUESTER_SCOPE_MISSING` (finance_admin), `NOT_HUMAN`, NC-5 `REFUSED:APPROVER_NO_LONGER_ELIGIBLE` (request `APPROVED`, attempts 0, no release, `APPLY_REFUSED` audit), restored → `RELEASED`; DRAFT → `REFUSED:NOT_APPROVED`; SUBSCRIPTION_END → `ACTION_NOT_APPLICABLE`; the A6 apply of a CONVERSION → `ACTION_NOT_APPLICABLE` |
| Payload schema | C2-AUTH-2 | 5 malformed payloads → `INVALID_INPUT` at create |
| Apply deadline | C2-AD-1; C2-U-5 | v1 request applied 100 h after approval (no key, AD-2). Unit: none for v1 content; `approved_at + 72 h` with the key; 6 malformed values and a missing approval instant fail closed |
| **History never deleted** | C2-HIST-1, C2-DB-1 | Across a further conversion in each direction, `BillingEvent`, `CheckoutIntent`, `LegalAcceptance`, flag and audit counts only grow; ended rows +2; an ended row is never reopened (`subscription already ended`); DELETE of a release, an application and an audit row refused |
| DB guard / trigger | C2-DB-1 | `cannot commit in APPLYING without a provider command`; `APPROVED → APPLIED` not allowed; APPLIED without application refused; a column change without a transition refused; a pending-provider request `cannot be APPLY_FAILED while a provider command is unconfirmed`; release DELETE / expiry edit / `RELEASED → CONVERTED` without a held ref / consumption at the expiry instant / early `EXPIRED` / a second release for an applied request all refused |
| No provider call inside a local transaction | C2-TX-1 | Probe on every fake provider call across the file: `violations = []`, probes > 20 |

`ccp-c2-conversion.integration.spec.ts`: **21 / 21 passed** (re-run after the lint fix: 21 / 21).
`ccp-c2-conversion.spec.ts` (unit): **6 / 6 passed** — C2-U-1 CONVERSION adds exactly the 4 apply pairs; C2-U-2 release machine exactly 4 of 16 pairs; C2-U-3 payload schema (4 valid, 8 invalid); C2-U-4 half-open window; C2-U-5 apply deadline; C2-U-6 `SubscriptionModule` and `.forRoot()` bind the ledger into the lifecycle and provide the conversion service.

## 6. Routes, Pact and gates

| Run | Result |
|---|---|
| `apps/platform-admin/src/tests/ccp-c2-conversion-routes.integration.spec.ts` (real JwtAuthGuard + RolesGuard) | **3 / 3**. `POST …/convert`: platform_owner, finance_admin, catalog_manager, support_admin, read_only_auditor 403 `requester_scope_missing`; a second commercial_ops 403 `not_requester`; super_admin 403 at the gate; the requester 200 `RELEASED`, replay 200 `replayed: true`. `GET …/conversion`: all 6 CCP roles 200; super_admin 403; tenant tier 403; 400 malformed id; 404 unknown; 409 `action_not_applicable` (GET and POST). 409 `apply_failed USAGE_TREATMENT_UNDEFINED` (DOWNGRADE); held → governed 200 `PENDING_PROVIDER` with the pending command, replay `replayed: true`; NC-5 409 `APPROVER_NO_LONGER_ELIGIBLE` (request stays `APPROVED`); tenant tier 403; 400 malformed |
| Consumer `platform-web-consumer` (run serially) | **52 / 52 interactions** (C1 recorded 45; +7: convert 200, convert 403, conversion 200 pending-provider, super_admin × 2, tenant tier × 2) |
| Provider `verify-platform-admin` (`ARAMO_RUN_PACT_PROVIDER=1`) | **2 / 2 provider tests passed**: the CCP route coverage gate (now including the 2 C2 routes) and the verification of all 52 interactions. New states `an approved governed-to-self-service conversion exists`, `a self-service-to-governed conversion is pending at the provider` |
| Consumer vs provider counts (A10: reported separately) | 52 consumer interactions; 52 verified by the platform-admin provider |
| `contract-parity:check` (new files intent-to-add in a temporary index) | 682 live routes (680 governed), 513 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified (C1: 680 / 678 / 511; +2 / +2 / +2) |
| `openapi:drift-check` | ok (9 files) |
| `redocly lint openapi/platform.yaml` | valid; 2 warnings (equal to the baseline) |
| `orphan-scopes:check` | ok (no new scope) |
| `env:passthrough-check` | ok (109 passthrough + 3 required-interp + 2 guarded; no new var) |
| `error-codes:check`, `tests:integration:check` | ok (no new error code; 49 integration roots) |
| `repo-map:generate` / `repo-map:check` | regenerated (3 files modified); ok — temporary `GIT_INDEX_FILE` with intent-to-add entries (real index untouched) |
| `nx run-many -t lint -p subscription platform-admin sign-service` | 0 errors (69 / 89 / 42 warnings, pre-existing kinds). Direct ESLint on every changed or new `.ts`: 0 errors after fixing 4 import-order errors |
| `nx run-many -t build -p subscription sign-service platform-admin --skip-nx-cache` | 3 projects + 29 dependency tasks succeeded; dist markers: `CommercialConversionService` in `dist/libs/subscription/src/index.d.ts`, `completeConfirmedInTx` in the dist lifecycle |
| `bash scripts/verify-vocabulary.sh` (new files intent-to-add) | OK: Tier 1, Tier 2 and front-door clean. No exemption touched; the `stripe-wire.ts` exemption is unchanged and unused |

## 7. Tests run and not run

| Suite | Result |
|---|---|
| `libs/subscription`, whole lib, `ARAMO_RUN_INTEGRATION=1`, `--maxWorkers=2` | **25 files, 484 / 484** |
| C2 + C1 + A6 lib specs re-run after the lint fix | 5 files, **86 / 86** |
| `apps/platform-admin`: C2 routes, C1, A6 apply routes, A3 routes, A1 role authorization, A9 role-change routes | **6 files, 155 / 155** |
| `apps/sign-service`: `billing.spec`, `ccp-c1-billing-commands.spec`, `personal-free.integration`, `sign-account.integration`, `sign-legal.integration`, `storage-quota.spec`, `ccp-a4-ats-sign-consumption.integration` (ATS-triggered Sign consumption golden) | **7 files, 52 / 52** |
| `apps/api` targeted (apply every lib migration, C2 included): `ccp-a4-ats-sign-availability` (ATS golden), `s2-erasure-integrity`, `tenant-reset`, `tr15-b2-erasure`, `portal-p4b-rtbf` | **5 files, 35 / 35** |
| **Not run:** the full `nx run api` (instructed); `verify-sign`, `verify-api`, `verify.ts`, `verify-ti.ts` Pact providers (no sign-service or apps/api returned shape changed); `apps/platform-web` / `sign-web` (backend-only slice; the console is B3) | — |

Host load during the runs: load averages 16 to 25.

## 8. Recovery and rollback

- An unconsumed release expires (lazily at checkout, webhook and read; `expireReleases` sweep). A failed apply is `APPLY_FAILED`, retryable by the requester; a refusal changes nothing. A pending-provider conversion recovers through C1 (retry, re-fetch) and completes in the transaction that applies the confirmed end; a failed completion is `APPLY_FAILED` and the requester's retry completes it without a second provider call.
- No destructive edit exists: releases, applications, commands and audit rows are append-only; an ended row is never reopened.
- Code: revert C2-1…C2-7.
- **Compensating migration** (documented, not shipped; never run against production, PBD §7.5), in one transaction:
  ```sql
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM subscription."CommercialConversionRelease")
       OR EXISTS (SELECT 1 FROM subscription."CommercialChangeRequest" WHERE action_type = 'CONVERSION' AND state IN ('APPLYING', 'APPLIED', 'APPLY_FAILED'))
       OR EXISTS (SELECT 1 FROM subscription."CommercialChangeApplication" WHERE action_type = 'CONVERSION') THEN
      RAISE EXCEPTION 'CCP-C2 compensation refused: conversion state exists';
    END IF;
  END $$;
  DROP TRIGGER "commercial_change_request_conversion_applying_commit" ON subscription."CommercialChangeRequest";
  DROP FUNCTION subscription."guard_commercial_conversion_applying"();
  DROP TRIGGER "commercial_conversion_release_guard" ON subscription."CommercialConversionRelease";
  DROP TABLE subscription."CommercialConversionRelease";
  DROP FUNCTION subscription."guard_commercial_conversion_release"();
  -- restore the CCP-A6 body of guard_commercial_change_request(): re-run lines 104-228 of
  -- 20261025200000_ccp_a6_transactional_apply/migration.sql verbatim (the C2 blocks are the only difference)
  ALTER TABLE subscription."CommercialChangeApplication"
    DROP CONSTRAINT "CommercialChangeApplication_action_type_check",
    ADD CONSTRAINT "CommercialChangeApplication_action_type_check" CHECK ("action_type" IN ('SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT')),
    DROP CONSTRAINT "CommercialChangeApplication_replaced_check",
    ADD CONSTRAINT "CommercialChangeApplication_replaced_check" CHECK ("replaced_subscription_id" IS NULL OR "action_type" = 'SUBSCRIPTION_OPEN');
  ```
  The guard refuses while any CONVERSION is in flight or applied; a provider subscription changed by a C2 command is reconciled by C1 and is not undone by this migration (a reversal is a new governed conversion).

## 9. Typed divergences and decision requests

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| **DR-C2-1** | Decision request (fail-closed) | Self-service → governed uses the C1 `IMMEDIATE` cancel with no proration or invoice parameters (TD-C1-5): provider defaults apply, so **no credit for the unused paid period**. No other cancel mode is chosen. A self-service row inside a commitment term is refused (`FINANCIAL_TREATMENT_UNDEFINED`, `COMMITMENT_TERM`). **Every Standard Business / Professional self-service row opened by checkout carries a 12-month commitment** (`commitment_months 12`), so until this is ruled, self-service → governed is in practice available only for held activations and rows without a commitment term. | **PO / Architect:** proration or credit on the immediate cancel, and the treatment inside a commitment term (or AT_PERIOD_END) |
| **DR-C2-2** | Decision request | Charter §7 has no release-TTL key and policy values are not code constants, so the release expiry is an **approved term of the request** (`release_expires_at`, signed by the approvers). A structural sanity bound of 30 days refuses a unit slip. | **PO:** keep per-request, or add a policy key (a Charter amendment) |
| **DR-C2-3** | Decision request (T8) | Governed → self-service: usage already charged to the governed period is not carried into the new self-service first period (the A6 fresh-open rule: only usage that would be stranded inside the new first period fails closed and holds the activation). | **Architect:** confirm that a mid-period conversion starts a fresh paid period, or rule a carry-over |
| TD-C2-1 | Design choice | Pending-provider uses APPLYING + the C1 command state (no new request state). A CONVERSION commits in APPLYING only with a provider command; `APPLYING → APPLY_FAILED` is refused while one is unconfirmed (an in-flight Stripe operation is never abandoned locally). AD-4 then keeps the apply TTL from expiring an in-flight conversion | Recorded (instructed preference) |
| TD-C2-2 | Lifecycle choice | Governed → self-service is `APPLIED` when the release is issued (C-21: releasing is Aramo-owned); the conversion's completion is tracked on the release (`CONSUMED`, `CONVERTED`, `EXPIRED`), so the Q14 slot is free while the tenant checks out | Recorded |
| TD-C2-3 | Choice | "Consumed exactly once" = bound to one checkout at checkout start. A session that later expires spends the release; a fresh request is needed. A failed session creation after the intent commit also spends it (the provider may have created the session) | Recorded |
| TD-C2-4 | Choice | A fresh release is refused (`RELEASE_CHECKOUT_OPEN`) while a consumed release's checkout is not provider-confirmed expired (TD-C1-4: only Stripe evidence ends a checkout); the C-17 expire command (C1) is the operator path | Recorded |
| TD-C2-5 | Behaviour (lifecycle) | `startCheckout`, `applyLocked`/`openRow` and `applyProviderState` gain the release and completion paths, active only with the ledger bound (SubscriptionModule always binds it; C2-U-6). Unbound, every path is exactly A6 / C1 | Recorded |
| TD-C2-6 | Scope (C-8) | The release, `pending_provider` and status are readable per request (`GET …/conversion`; TD-C1-9 for the request). The subscription workbench, the reconciliation report and the tenant-facing "pending, contact support" state are B3 / C6 | For B3 / C6 |
| TD-C2-7 | Name to unify | The apply deadline is read from the snapshotted policy key `apply_deadline_hours` (refusal `APPLY_DEADLINE_PASSED`, no state change). A6-R owns `APPLY_EXPIRED` and B5 the v2 content; the key name and refusal code must be unified at merge, and A6-R's expiry must treat a CONVERSION in APPLYING as an apply in progress (it never expires APPLYING, AD-4) | **For the lead at merge** |
| TD-C2-8 | Contract addition | `CommercialChangeApplication.action_type` enum gains `CONVERSION` (OpenAPI and CHECK); `COMMERCIAL_C2_CONVERSION_TRANSITIONS` exported | Recorded |
| TD-C2-9 | Duplication | The G3 / T8 checks the conversion needs mirror `CommercialApplyService` in `commercial-conversion.ledger.ts` (the A6 file is untouched because A6-R changes it; `downgradedTerms` is imported). TD-A6-R-1 (same-period downgrade within consumed + reserved) is not applied to conversions; they keep the A6 rule as built (upgrade-or-equal, no open reservation) | **For the lead at merge:** route both through one helper once A6-R lands |
| TD-C2-10 | Test change | The C1 spec and the Pact C1 state created CONVERSION requests with free-form payloads; they now use a structurally valid `TO_GOVERNED` payload (never applied). A9-U-4 now expects the apply set for CONVERSION | Recorded |
| TD-C2-11 | Gap | `expireReleases` exists but no worker calls it (off-by-default workers are out of scope; expiry is also enforced lazily at every use). A release left `CONSUMED` by an abandoned checkout stays `CONSUMED` (spent) | For D3 / D5 |
| TD-C2-12 | Edge | If a governed row named by a live release is ended or replaced through another governed request, the release no longer matches (checkout refused, activation held) and expires; it is not cancelled | Recorded |
| TD-C2-13 | Merge note | Overlap expected with parallel slices: the guard function (A8, A6-R, B5 branches), `commercial-change-request.ts`, `subscription-lifecycle.service.ts`, `schema.prisma`, `src/index.ts`, `subscription.module.ts`, `openapi/platform.yaml`, `api-surface-manifest.json`, `platform.module.ts`, the platform-web consumer, `verify-platform-admin.ts`, `ccp-a9-role-change.spec.ts`, `doc/generated/repo-map.*`. Migration `20261026060000` must sort after every earlier program migration | For the lead |

No correction-1 trigger (PBD §2.4) arose: DR-C2-1…3 are decision requests with fail-closed behaviour, not decisions taken. Production hold (C-26…C-28) unchanged: no checkout enablement, no env default, no live key; C2 adds no Stripe call (the only provider operations are C1 commands and re-fetches, outside any transaction, C2-TX-1).

## 10. Vocabulary result

`bash scripts/verify-vocabulary.sh`: OK. Tier 1, Tier 2 and front-door retirement are clean. No exemption allowlist was touched; the Stripe wire exemption (`stripe-wire.ts`) is unchanged and not used by C2.
