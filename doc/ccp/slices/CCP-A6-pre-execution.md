# CCP-A6 — pre-execution check (lead-written prerequisites; the executor appends P-6 path:line)

| | |
|---|---|
| **Slice** | CCP-A6: transactional apply + D2/H5 hold |
| **Schedule** | PBD §5 row A6; Conversion Rule (`Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED`) |
| **Baseline** | `feat/ccp-commercial-control-plane` at `2bb41b23`. A1–A5 and A10 are committed and merged; A9 is in parallel. |

## Prerequisites
| Prerequisite | Evidence | Status |
|---|---|---|
| A3 evidence | `doc/ccp/slices/CCP-A3-acceptance.md`; NC-5 ratified by the Architect (`doc/ccp/decisions.md`) | ✅ |
| A5 evidence | `doc/ccp/slices/CCP-A5-acceptance.md`. TD-A5-1 (terms read from the pinned version) is pending Architect ratification. A6 builds on the pinned-version reading. | ✅ (flagged) |
| **Production DB privilege and cross-schema transaction facts (Charter §6.2)** | **Read-only check on 2026-10-25:** a single database `aramo` (PostgreSQL 17.11). api, sign-service and platform-admin all connect as role **`aramo`**, which is a **superuser** (`rolsuper=t`). Schemas `subscription`, `entitlement` and `identity` are **all owned by `aramo`**. The only other login role is `aramo_intelligence` (non-superuser, TI service). | ✅ |
| **Path decision** | **The single local DB transaction is feasible in prod:** one database, one owning role, and a raw cross-schema write on the caller's client (precedent: `insert-decision-record.ts`). **Recorded caveat:** the pending privilege-separation work (the S2 erasure blocker) would introduce per-schema roles. If that lands, the **outbox fallback** (Reconciliation Report §1 C3) becomes mandatory and needs a correction-1 check at that time. | ✅ single transaction |

## Binding rules
- NC-5 (ratified): re-check eligibility at apply under the SNAPSHOTTED policy version and chain. Fail closed with no mutation. Never rewrite signatures.
- The Conversion Rule:
  - checkout is refused under the billing lock;
  - webhook-time hold: raise a flag, keep the intent `CREATED`, record `IGNORED`;
  - hold reasons compose;
  - `APPLIED` only when both sides commit;
  - an external change is never reported as committed on local commit alone.
- Out of scope: Stripe commands (C1); the conversion workflow (C2); revoke (A7).
- **Production hold:** live Stripe, public signup and test checkout stay OFF in prod (verified 2026-10-25). A6 is built and tested locally only.

## Correction-1 trigger check
None.

## Path:line re-verification (executor, 2026-10-25, worktree `wip/ccp-a6` at `a2468acf`)

The Conversion Rule cites `subscription-lifecycle.service.ts` at `origin/main` `78dbd6d3`. A4 and A5 have since added code above the cited lines, so the line numbers moved. Each clause below was re-read at `a2468acf`. The **content** of every cited line is unchanged; only its position moved.

| Conv. citation (`78dbd6d3`) | Now (`a2468acf`) | Content re-verified |
|---|---|---|
| `:31-32` header "activate → … ends any other open (MANUAL / DEVELOPMENT) one in the same tx." | `subscription-lifecycle.service.ts:37-38` | ✅ verbatim |
| `:395` checkout open-row read (outside the lock) | `:433` (now product-scoped, `openBaseSubscription(input.tenant_id, product_key)`, CCP-A4) | ✅ still `this.prisma`, before the `$transaction` at `:444` |
| `:396-399` "MANUAL / DEVELOPMENT subscription may be replaced…" + `ALREADY_SUBSCRIBED` | `:434-438` | ✅ verbatim |
| `:406` checkout `$transaction` | `:444` | ✅ creates the `CheckoutIntent` (+ `LegalAcceptance`), no lock |
| `:435` external checkout-session creation | `:473` | ✅ outside the transaction |
| `:577-578` webhook `$transaction` + `pg_advisory_xact_lock(hashtextextended('billing:'‖tenant, 0))` | `:624-625` | ✅ verbatim |
| `:584-597` country and domain guards, `IGNORED` when held | `:630-644` | ✅ |
| `:606-630` `guardFlag` | `:653-677` | ✅ raise via `ON CONFLICT … WHERE resolved_at IS NULL DO NOTHING`, resolve via `updateMany` |
| `:650` "An ended subscription is never reopened" | `:699` | ✅ verbatim |
| `:720-728` webhook-time end of the open row | `:783-791` (product-scoped) | ✅ `open !== null && !sends` → IGNORED (`:785-788`); otherwise the open row is ended (`:789-791`) |
| `schema.prisma:112-116` source CHECK comment | `libs/subscription/prisma/schema.prisma:187-191` | ✅ "CHECK: MANUAL \| DEVELOPMENT \| SELF_SERVICE \| FREE" |
| `schema.prisma:181` CheckoutIntent statuses | `schema.prisma:271` | ✅ "CHECK: CREATED \| COMPLETED \| EXPIRED" |
| `schema.prisma:206` BillingEvent idempotency | `schema.prisma:296` | ✅ `@@unique([provider, provider_event_id])` |
| flag CHECK `20261022100100_billing_account_country_guard/migration.sql:38` | same `:38` | ✅ |
| flag widening `20261022110100_billing_flag_domain_reason/migration.sql:8-10` | same `:8-10` | ✅ (DROP + ADD CONSTRAINT, additive) |
| `sign-signup.service.ts:58`, `:59`, `:390` | same | ✅ `SIGN_SIGNUP_OWNER_ROLE_KEYS`, `SIGN_CAPABILITIES = ['core', 'sign']`, `grantCapabilities(...)` |

Other substrate the A6 row and Reconciliation Report §1 C3 rely on:

| Fact | `path:line` | Re-verified |
|---|---|---|
| A3 guard function A6 replaces ("CCP-A3 transitions only … until CCP-A6 replaces this function") | `libs/subscription/prisma/migrations/20261025120000_ccp_a3_change_request_approval/migration.sql:167-171` | ✅ |
| A3 apply-time NC-5 re-check, read-only, takes the caller's `tx` | `libs/subscription/src/lib/commercial/commercial-change-request.service.ts:506` (`assertApplyEligible`) | ✅ |
| The pure re-check refuses anything not `APPROVED` | `libs/subscription/src/lib/commercial/commercial-approval-eligibility.ts:206` | ✅ (A6 admits `APPLY_FAILED` for the retry, TD-A6-6) |
| One open BASE per (tenant, product) (G2) | `libs/subscription/prisma/migrations/20261025140000_ccp_a4_product_dimension/migration.sql:81` | ✅ partial unique index |
| Pin-reason CHECK A6 widens (TD-A5-9) | `libs/subscription/prisma/migrations/20261025160000_ccp_a5_plan_version/migration.sql:317` | ✅ `('PROVIDER_PLAN_CHANGE')` |
| Raw cross-schema write in the caller's transaction (precedent for `grantCapabilitiesInTx`) | `libs/policy-store/src/lib/insert-decision-record.ts:39-45` | ✅ |
| Entitlement grant shape (`createMany … skipDuplicates`) | `libs/entitlement/src/lib/entitlement.repository.ts:52-63` | ✅ |
| New nx edge subscription → entitlement: base path exists | `tsconfig.base.json:61`; vitest alias `vitest.shared.ts:111` | ✅ present. The third place (`libs/subscription/tsconfig.lib.json` dist paths for `@aramo/entitlement` and its `@aramo/auth` type dependency) is added by A6. No cycle: `libs/entitlement` imports only `@aramo/common` and `@aramo/auth`, and neither imports `@aramo/subscription`. |

## Names fixed by this record (Conv. C-4, C-7(b), O-3; checked against `scripts/verify-vocabulary.sh`)

| Item | Name |
|---|---|
| New `BillingRefusal` value (C-4) | `GOVERNED_SUBSCRIPTION_OPEN`. Surfaced as 409 `ESIGN_BILLING_CONFLICT`, `details.reason` `governed_subscription_open`. `ALREADY_SUBSCRIBED` keeps its meaning (an open self-service row, C-5). |
| New `BillingReconciliationFlag.reason` (C-7(b)) | `governed_subscription_open` (additive CHECK widening) |
| New pin-history reason (TD-A5-9) | `CHANGE_REQUEST` (additive CHECK widening) |
| Apply route | `POST /platform/commercial/change-requests/{id}/apply` |
| Governed subscription (C-1, C-6) in A6 | an open BASE row with `source = 'MANUAL'`. Definition (b) has no rows until B4 (O-5). Definition (c) is contained in (a) by construction in A6: every applied open writes a MANUAL row, and change and end target MANUAL rows only. |
