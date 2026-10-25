# CCP-A6 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.1 A6 row. Governing instruments: the Conversion Rule `Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED` (C-1…C-10, C-16, C-17, C-21…C-24), MP-A2 (G2/G3), the Reconciliation Report §1 C3, NC-5 (TD-A3-0, ratified) and the Architect ruling of 2026-10-25 on TD-A5-1 (T1…T12, usage rule T8).

| | |
|---|---|
| **Slice** | CCP-A6: transactional apply + D2/H5 hold |
| **Branch / baseline** | `wip/ccp-a6` at `a2468acf` (A1–A5 and A10 merged; A9 built in parallel and merged by the lead before A6) |
| **Pre-execution record** | `doc/ccp/slices/CCP-A6-pre-execution.md` (prod DB facts → single-transaction path; P-6 path:line re-verification; the names fixed for C-4 / C-7(b) / O-3) |
| **Local commit SHAs** | **pending (lead commits).** Nothing committed or pushed by the executor. |
| **HALT conditions hit** | **None.** The single-transaction path fits the validated DB facts (one database, one owning role). No path reports an external change as committed on local commit: every Stripe-owned operation is refused (G1), never performed (C-22, C-23). |

## 1. Commit map (proposed; SHAs pending, lead commits)

| # | Proposed commit | Files |
|---|---|---|
| A6-0 | `CCP-A6: P-6 path:line re-verification and the fixed names` | `doc/ccp/slices/CCP-A6-pre-execution.md` |
| A6-1 | `CCP-A6: apply migration (A6 transition table ∪ A9 role branch, no-APPLYING-commit, CommercialChangeApplication, flag and pin-reason widening) and Prisma model` | `libs/subscription/prisma/migrations/20261025200000_ccp_a6_transactional_apply/migration.sql` (new); `libs/subscription/prisma/schema.prisma` |
| A6-2 | `CCP-A6: grantCapabilitiesInTx and the subscription → entitlement edge (3-place wiring)` | `libs/entitlement/src/lib/grant-capabilities-in-tx.ts` (new); `libs/entitlement/src/index.ts`; `libs/subscription/tsconfig.lib.json` (dist paths `@aramo/entitlement`, `@aramo/auth`). The `tsconfig.base.json:61` path and the `vitest.shared.ts:111` alias already existed. |
| A6-3 | `CCP-A6: transactional apply service (billing lock, NC-5, G1/G2/G3, T6/T8/T10)` | `libs/subscription/src/lib/commercial/commercial-apply.service.ts`, `src/lib/billing/governed-subscription.ts` (new); `commercial-change-request.ts` (A6 transitions, A6 payload schemas), `commercial-change-request.service.ts` (error code), `commercial-approval-eligibility.ts` (APPLY_FAILED retry), `plan-version.ts`, `product-registry.ts`, `subscription.module.ts`, `src/index.ts` |
| A6-4 | `CCP-A6: Conversion Rule hold — checkout refused under the billing lock; webhook-time hold` | `libs/subscription/src/lib/billing/subscription-lifecycle.service.ts`; `apps/sign-service/src/app/billing/esign-billing.controller.ts`; `apps/sign-web/src/workspace/api.ts`; `libs/common/src/lib/errors/aramo-error.ts` (comment); `openapi/sign.yaml` |
| A6-5 | `CCP-A6: C-16/C-17 read-only pre-cutover check` | `libs/subscription/src/lib/billing/checkout-cutover-check.ts`, `libs/subscription/prisma/check-checkout-cutover.ts` (new); `package.json` (`billing:cutover-check`) |
| A6-6 | `CCP-A6: apply route, OpenAPI and gates` | `apps/platform-admin/src/app/platform/platform-commercial-apply.controller.ts`, `dto/commercial-change-application.dto.ts` (new); `platform.module.ts`; `openapi/platform.yaml`; `ci/config/api-surface-manifest.json` |
| A6-7 | `CCP-A6: tests (apply, hold, routes) and the shared helper; A3/A4 spec adjustments` | `libs/subscription/src/tests/ccp-a6-apply.integration.spec.ts`, `ccp-a6-hold.integration.spec.ts`, `support/ccp-a6.ts`, `apps/platform-admin/src/tests/ccp-a6-commercial-apply-routes.integration.spec.ts` (new); `libs/subscription/src/tests/support/ccp-a3-database.ts` (`applyCcpA6Schema`, `libMigrations`); `commercial-approval-eligibility.spec.ts`, `commercial-change-request.integration.spec.ts`, `ccp-a4-product-dimension.integration.spec.ts`; `apps/platform-admin/src/tests/ccp-a3-commercial-change-request-routes.integration.spec.ts`; `apps/sign-service/src/tests/billing.spec.ts` |
| A6-8 | `CCP-A6: Pact — the new refusal (sign-workspace / verify-sign) and the apply route (platform-web / verify-platform-admin)` | `pact/consumers/sign-workspace-consumer/src/sender-console.consumer.test.ts`; `pact/provider/src/verify-sign.ts`; `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts`; `pact/provider/src/verify-platform-admin.ts` |
| A6-9 | `CCP-A6: acceptance evidence` + `CCP-A6: regenerate repo map` | `doc/ccp/slices/CCP-A6-acceptance.md` (new); `doc/generated/repo-map.{coupling,files,projects}.json` |

Totals: **13 new files, 33 modified files (46 paths)**. **Unchanged:** every existing migration; `pact/provider/src/verify-api.ts` (no apps/api returned shape changed); `CommercialChangeRequestDto` (A9 adds `applied_at`; A6 does not touch it); `doc/ccp/decisions.md`; the runbooks (inventory rows 15/16 are their own doc proposal).

## 2. Design as implemented

**One local transaction** (`CommercialApplyService.apply`), on the subscription client:
1. `takeBillingLock(tx, tenant)` = `pg_advisory_xact_lock(hashtextextended('billing:'‖tenant, 0))`, the same lock (and helper) the webhook path and the checkout now take;
2. `SELECT … FOR UPDATE` on the request; an `APPLIED` request replays (nothing written);
3. NC-5: `assertApplyEligible(id, platform_tenant, tx)` re-checks each recorded approval under the **snapshotted** chain against the live roster (read-only; integrity checksum included);
4. `APPROVED | APPLY_FAILED → APPLYING` (`apply_attempts + 1`);
5. guards: **G1** a row with `billing_subscription_ref` or `source = SELF_SERVICE` → `STRIPE_OWNED`; **G2** the payload names the row it replaces (`replaces_subscription_id`, or `null`), anything else → `TARGET_STALE`; the prior row ends in the same transaction (partial unique index as backstop → `ONE_OPEN_BASE_VIOLATION`); **G3** only a `PUBLISHED` version of the named plan of this product; INACTIVE/FREE plans and a mismatched tenant kind refused; **T8** usage rules (§6);
6. the subscription write; then `grantCapabilitiesInTx` (raw cross-schema INSERT on the caller's client; the product bundle `sign → ['core','sign']`, `sign-signup.service.ts:59`);
7. `CommercialChangeApplication` (append-only, `UNIQUE(change_request_id)`) and the audit events;
8. `APPLYING → APPLIED`.

**DB backstops (migration):** the guard refuses `APPLIED` unless the application row exists and matches the request, the governed subscription row is in the applied state on the applied version, and every recorded capability exists in `entitlement."TenantEntitlement"`. A deferred constraint trigger refuses to **commit** a request left in `APPLYING`. So `APPLIED` exists only when both sides committed together.

**Failure** (any guard, fault or DB error after step 3): the transaction rolls back in full; a separate transaction records `APPLYING → APPLY_FAILED` (`apply_attempts + 1`) with a `COMMERCIAL_CHANGE_REQUEST_APPLY_FAILED` audit row (failure code and detail). `APPLY_FAILED → APPLYING` is the retry. **Refusal** (NC-5, not approved, integrity, authority): no state change, no domain write, one `COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED` audit row.

**Guard function = the union** (lead instruction, 2026-10-25): A3 base ∪ the CCP-A9 role branch (`ROLE_GRANT`/`ROLE_REVOKE`: `APPROVED → APPLYING → APPLIED`, `APPLY_FAILED` unreachable; marked "preserved from CCP-A9", modelled from the lead's description because A9's files are not in this worktree) ∪ the A6 branch for `SUBSCRIPTION_OPEN/_CHANGE/_END` and `ENTITLEMENT_GRANT`. The A6-only rules (attempt counting, `applied_at`, the APPLIED backstop, the no-APPLYING-commit trigger) apply only to the A6 action types; the role branch keeps A9's rules. Test A6-SM-A9.

**Conversion Rule hold** (`subscription-lifecycle.service.ts`): checkout runs an early read (fail fast, before any provider side effect) and then the **authoritative** C-1 / C-5 decision under the billing lock in the transaction that creates the `CheckoutIntent` (C-2); the session is created after commit (C-3). The webhook path, under the lock it already held, holds a new activation when an open governed row exists, in any non-ended provider state and whatever the intent's age: a `governed_subscription_open` flag via `guardFlag`, `IGNORED` with the hold named (recorded by `handleEvent` as the `BillingEvent` outcome), intent kept `CREATED`, governed row untouched (C-6, C-7). A later sync resolves the flag only when the conflict is gone (C-9); each reason keeps its own flag (C-10). `openRow` refuses a governed row as defence in depth.

## 3. Fault-injection and concurrency outputs (real Postgres 17)

`libs/subscription/src/tests/ccp-a6-apply.integration.spec.ts`, **26 / 26 passed**.

| Obligation | Test ID | Output |
|---|---|---|
| Fault after the subscription write → no partial state | A6-FAULT-after_subscription_write | `FAILED:UNEXPECTED`; the domain snapshot (subscriptions, entitlements, pin events, applications, domain audit, approvals) equals the pre-apply snapshot; request `APPLY_FAILED`, attempts 1; retry → `APPLIED`, attempts 2, application attempt 2; audit `…APPLY_FAILED`, `…APPLIED` |
| Fault after the entitlement write | A6-FAULT-after_entitlement_write | same |
| Fault before APPLIED | A6-FAULT-before_applied | same |
| A real DB fault on the entitlement side | A6-FAULT-DB | a raising trigger on `entitlement."TenantEntitlement"`: `CommercialApplyFailedError` naming `a6 injected entitlement fault`; snapshot unchanged; 0 open rows; `APPLY_FAILED`, attempts 1 |
| Idempotency (re-apply) | A6-IDEM-1 | `replayed: true`, same application id, snapshot and audit count unchanged; a raw second application INSERT → `CommercialChangeApplication_change_request_id_key` |
| Concurrent commands | A6-CONC-1 | 5 concurrent applies of one request: 1 `replayed: false`, 4 `replayed: true`; 1 application id; 1 open row; 1 `COMMERCIAL_CHANGE_REQUEST_APPLIED`; attempts 1 |
| Concurrent writers under the billing lock | A6-CONC-2 | apply ‖ a raw session taking `billing:<tenant>` and opening a row only if none: outcome ∈ {`APPLIED`/racer skipped, `FAILED:TARGET_STALE`/racer wrote}; exactly 1 open row |
| The apply waits on the lock | A6-LOCK-1 | while a session holds `billing:<tenant>`: a backend waits on the advisory lock, request still `APPROVED`, attempts 0, 0 rows; on release → `APPLIED` |
| Retries | A6-G2-2 | stale open: `FAILED:TARGET_STALE` twice, attempts 1 → 2, nothing changed, 2 `APPLY_FAILED` audit rows |
| State transitions (DB guard) | A6-SM-DB | `APPROVED → APPLIED` refused; `APPROVED → APPLY_FAILED` refused; `APPLYING` without counting refused (`apply_attempts 0 -> 0`); a committed `APPLYING` refused at COMMIT (`cannot commit in APPLYING`); `APPLIED` without its application refused; `APPLYING → APPLY_FAILED` in one transaction commits; `APPLY_FAILED → APPLIED` refused; retry → `APPLIED`, attempts 2; `APPLIED` frozen; application UPDATE/DELETE refused; a CREDIT `APPROVED → APPLYING` refused |
| A9 transitions preserved | A6-SM-A9 | `ROLE_GRANT` and `ROLE_REVOKE`: `APPROVED → APPLYING → APPLIED` commits; `APPLYING → APPLY_FAILED` refused |
| Unit state table | A6-SM-1 (`commercial-approval-eligibility.spec.ts`) | exactly 10 of 81 state pairs; `APPLIED` terminal; `APPLY_FAILED` only → `APPLYING`. A3-SM-1 now pins `COMMERCIAL_A3_TRANSITIONS` (6 pairs) |

Domain operations: A6-OPEN-1 (MANUAL row pinned to the PUBLISHED version, `core`+`sign` granted, events `…SUBSCRIPTION_OPENED`, `…ENTITLEMENT_GRANTED`, `…APPLIED`; allowance `subscribed, limit 100`), A6-G2-1 (prior DEVELOPMENT row ended `CANCELED` in the same transaction; anchor kept), A6-CHANGE-1, A6-END-1, A6-GRANT-1 (inserted `['sign']`, then `['core']`; `ats` → `CAPABILITY_NOT_IN_PRODUCT`), A6-G1-1 (`STRIPE_OWNED` for open, change and end of a SELF_SERVICE row, and for a provider-linked MANUAL row; snapshot unchanged), A6-G3-1 (`PLAN_VERSION_NOT_PUBLISHED`, `PLAN_VERSION_MISMATCH`, `PLAN_NOT_FOUND`, `PLAN_NOT_ASSIGNABLE`, `PLAN_TENANT_KIND_MISMATCH`).

**NC-5 through the real apply path (TD-A3-0, the 3 Architect tests):**

| Test | ID | Output |
|---|---|---|
| Role revoked between approval and apply | A6-NC5-a | `REFUSED:APPROVER_NO_LONGER_ELIGIBLE`; snapshot unchanged; request `APPROVED`, attempts 0, `applied_at` null; last audit row `…APPLY_REFUSED` |
| Policy-version change after creation | A6-NC5-b | v2 ACTIVE before submit: applied; `policy_version_id` = v1 on the request and on every audit row of the request; expiry = 72 h (v1), not 24 h (v2) |
| Signature preserved | A6-NC5-c | `row_to_json` of the approval and the request byte-identical after the refusal; after the role is restored the same approval applies |

Authority (A6-AUTH-1): `REQUESTER_SCOPE_MISSING` (finance_admin), `NOT_HUMAN`, `NOT_FOUND`, `ACTION_NOT_APPLICABLE` (CREDIT), `NOT_APPROVED` (DRAFT and PENDING_APPROVAL), `INTEGRITY` (tampered payload); none changes the request.

**Webhook and console serialize under the billing lock** (A6-H-SER, hold spec): 3 rounds; the test session holds `billing:<tenant>`, the apply and the webhook sync both wait (2 advisory waiters, 0 rows); on release exactly 1 open row: console-first → `APPLIED` + `IGNORED`, intent `CREATED`, flag open; webhook-first → `FAILED:STRIPE_OWNED` + `APPLIED`, row SELF_SERVICE.

## 4. Hold test outputs

`libs/subscription/src/tests/ccp-a6-hold.integration.spec.ts`, **10 / 10 passed**.

| Clause | Test ID | Output |
|---|---|---|
| C-1 checkout refused | A6-H-C1 | `GOVERNED_SUBSCRIPTION_OPEN`; 0 intents; 0 provider account calls; 0 sessions |
| C-5 preserved | A6-H-C5 | SELF_SERVICE → `ALREADY_SUBSCRIBED`; DEVELOPMENT still replaceable (`opened ACTIVE (ended DEVELOPMENT)`) |
| C-2 decision under the lock | A6-H-C2 | the checkout waits on the lock; a MANUAL row commits meanwhile; on release → `GOVERNED_SUBSCRIPTION_OPEN`, 0 intents, 0 sessions |
| C-6/C-7 hold, intent predates the governed row | A6-H-W1 | `IGNORED` "governed_subscription_open: held for reconciliation…"; 1 open flag; intent `CREATED`; governed row byte-identical; open rows `[MANUAL]`; `BillingEvent` `IGNORED` with the detail; a re-sync keeps exactly 1 flag |
| A pre-existing CheckoutIntent (written before A6), with and without a session | A6-H-W2 | held the same way, both cases |
| Non-sending state | A6-H-W3 | `incomplete` → held, flag raised, governed row open |
| C-10 composition + C-9 | A6-H-C10 | non-US + non-authoritative + governed → 3 open flags, detail names all 3; country and domain fixed → those 2 resolve, governed stays, still `IGNORED`, intent `CREATED`; governed END applied → next sync `APPLIED` "opened ACTIVE", 0 open flags, all 3 resolved, intent `COMPLETED`, open rows `[SELF_SERVICE]` |
| C-9 webhook-confirmed end | A6-H-C9 | provider `canceled` → flag resolved, nothing opened, MANUAL row kept |
| Serialization | A6-H-SER | §3 |

Pact for the new refusal: §7.

## 5. C-16 query and its dry-run output

Query (a), product-scoped refinement of the C-16 reference query (TD-A6-9), `libs/subscription/src/lib/billing/checkout-cutover-check.ts` (`C16_QUERY_A`):

```sql
SELECT ci.tenant_id::text AS tenant_id, ci.id::text AS intent_id, p.key AS plan_key, p.product_key,
       to_char(ci.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
       (ci.provider_session_ref IS NOT NULL) AS has_session
  FROM subscription."CheckoutIntent" ci
  JOIN subscription."Plan" p ON p.id = ci.plan_id
 WHERE ci.status = 'CREATED'
   AND EXISTS (SELECT 1 FROM subscription."TenantSubscription" ts
                WHERE ts.tenant_id = ci.tenant_id AND ts.ended_at IS NULL AND ts.source = 'MANUAL'
                  AND ts.product_key = p.product_key AND ts.composition_role = 'BASE')
 ORDER BY ci.tenant_id, ci.created_at, ci.id
```

(b) open rows by product / source / status, (c) open flags by reason, (d) tenants with an open MANUAL row. One `BEGIN TRANSACTION READ ONLY` session, rolled back. Command: `DATABASE_URL=… npm run billing:cutover-check`. Exit 0 = no conflict; 1 = C-17 HALT; 2 = could not run.

Dry run on a production-like fixture (test A6-C16: 3 tenants, 2 MANUAL + 1 SELF_SERVICE, 4 intents of which 2 conflict, 1 open flag). Not run against production (no production access; PBD §7.5):

```
[cutover-check] session: BEGIN TRANSACTION READ ONLY (rolled back; nothing written)
[cutover-check] (a) CREATED checkout intents for tenants with an open MANUAL row: 2
[cutover-check]   tenant=0190c160-0000-7000-8000-000000000001 intent=0190c160-0000-7000-8000-0000000000a1 plan=aramo-sign-standard-business-v1 product=sign created_at=2026-10-20T09:00:00.000Z provider_session=present
[cutover-check]   tenant=0190c160-0000-7000-8000-000000000002 intent=0190c160-0000-7000-8000-0000000000a2 plan=aramo-sign-standard-business-v1 product=sign created_at=2026-10-20T09:00:00.000Z provider_session=absent
[cutover-check] (b) open subscription rows by product / source / status: 2 groups
[cutover-check]   sign MANUAL ACTIVE: 2
[cutover-check]   sign SELF_SERVICE ACTIVE: 1
[cutover-check] (c) open reconciliation flags by reason: 1 reasons
[cutover-check]   governed_subscription_open: 1
[cutover-check] (d) tenants with an open MANUAL row: 2
[cutover-check]   tenant=0190c160-0000-7000-8000-000000000001 product=sign plan=aramo-sign-included-v1 period_anchor=2026-10-01T00:00:00.000Z status=ACTIVE
[cutover-check]   tenant=0190c160-0000-7000-8000-000000000002 product=sign plan=aramo-sign-included-v1 period_anchor=2026-10-01T00:00:00.000Z status=ACTIVE
[cutover-check] HALT (C-17): 2 open intent(s) need a PO-recorded disposition before cutover.
```

Exit 1. After the two dispositions (intents EXPIRED) the same command prints `(a) … : 0` and `[cutover-check] OK: no open checkout intent conflicts with a MANUAL subscription.`, exit 0. Proven read-only: the counts and an md5 of every CheckoutIntent row are equal before and after; a write inside a `READ ONLY` session is refused by Postgres (`read-only transaction`).

## 6. Architect ruling 2026-10-25 (TD-A5-1 ratified; T1…T12)

| Rule | Where | Evidence |
|---|---|---|
| T1 maker-checker | A3 chain + apply authority = the action's requester scope | A6-AUTH-1, A6-RI-APPLY |
| T2 eligibility | tenant (exists, kind), product (registry, product-scoped rows), subscription state (open, MANUAL, BASE), permitted action (A6 set), target version PUBLISHED | A6-G3-1, A6-G1-1, A6-END-1 (`TARGET_STALE`), A6-AUTH-1 |
| T3 old and new `plan_version_id` | `CommercialChangeApplication.from/to_plan_version_id`; `SubscriptionVersionPinEvent` (reason `CHANGE_REQUEST`); audit payloads | **A6-T3-1** (with A6-CHANGE-1) |
| T4 policy, chain, distinct humans, NC-5 | A3 + `assertApplyEligible` | A6-NC5-a/b/c |
| T5 billing ownership | G1 | A6-G1-1, A6-H-SER |
| T6 effective date, no retroactive change | `effective_at` (= apply instant) in every audit payload; an open's anchor may be past but never future; a replacement keeps the prior anchor | A6-T8-2 (`FUTURE_EFFECTIVE_DATE`), A6-G2-1 |
| T7 one transaction | §2, §3 | A6-FAULT-* |
| T8 usage integrity | §6.1 | **A6-T8-1**, **A6-T8-2** |
| T9 idempotency, concurrency | UNIQUE application per request; billing lock; FOR UPDATE | A6-IDEM-1, A6-CONC-1/2, A6-LOCK-1, A6-GRANT-1 |
| T10 audit | `COMMERCIAL_CHANGE_REQUEST_APPLIED` carries outcome, requester, reason, policy checksum (+ the event's `policy_version_id`), the approvals (id, step, approver, attestation, time), old and new version, capabilities, effective timestamp | A6-T3-1 |
| T11 failures visible, recoverable | `APPLY_FAILED` + audit; refusal audit; never `APPLIED` early (DB backstops) | A6-FAULT-*, A6-SM-DB |
| T12 tenant / product isolation | product-scoped selectors; another product's row is `TARGET_NOT_FOUND` | **A6-T12-1** (isolation product registered in the test DB only) |
| Publishing never moves a subscription | `PlanVersionRepository.publish` retires v1; no subscription changes | **A6-PUB-1 / A6-ASTRE-1** |

**Astre-shaped case (A6-ASTRE-1).** A MANUAL ACTIVE subscription on `aramo-sign-included-v1` pinned to v1, `core`+`sign` entitled, 42 envelopes consumed in the current period (status `limit 100, used 42, remaining 58`). Then v2 of the same plan (250 envelopes) is published (v1 → RETIRED), and for OTHER tenants: an open on v2 (the new subscriber gets `limit 250`), an end, an entitlement grant, a second end, and an open naming the RETIRED v1 (`FAILED:PLAN_VERSION_NOT_PUBLISHED`). The Astre-shaped tenant's domain snapshot (row JSON, entitlements, pin events, applications, domain audit), usage rows, allowance status and account view are **byte-identical** before and after, and its `plan_version_id` is still v1.

### 6.1 T8 as implemented, and the typed decision requests

The usage ledger counts per (tenant, allowance key, `period_start`), so keeping the period keeps the consumption. Defined, and implemented: a same-period, immediately effective **upgrade** (every allowance, capacity and short-window cap of the old version met or exceeded by the new one; the anchor kept). A6-T8-1: 100 → 200 after 70 used → `limit 200, used 70, remaining 130`, ledger byte-identical. No proration, reset, rollover or partial-period policy exists. Everything else fails closed with `USAGE_TREATMENT_UNDEFINED` (A6-T8-2, nothing written):

| Decision request | Typed refusal (`details.kind`) | Case | Needs |
|---|---|---|---|
| **DR-A6-1** | `DOWNGRADE` | any change (CHANGE, or an OPEN replacing a row) where a limit drops, an allowance, capacity or period kind disappears, or a window cap is added or tightened | a PO / Architect usage treatment for downgrades |
| **DR-A6-2** | `CROSS_PERIOD` | an OPEN replacing a row with a different anchor; a fresh OPEN whose first period would strand usage recorded under another alignment (it would stop counting) | a cross-period treatment (or a rule that the anchor is always inherited) |
| **DR-A6-3** | `OPEN_RESERVATIONS` | a same-period change while RESERVED usage rows of the product exist | whether in-flight reservations carry across a term change |
| **DR-A6-4** | `FUTURE_EFFECTIVE_DATE` | an OPEN whose `period_anchor` is in the future | whether future-dated governed opens are allowed, and their usage semantics |

## 7. Pact, routes and gates

| Run | Result |
|---|---|
| Consumers `sign-consumer` / `sign-web-consumer` / `sign-workspace-consumer` | **11 / 6 / 12 interactions = 29** (sign-workspace +1: `POST /v1/sign/billing/checkout` → 409 `ESIGN_BILLING_CONFLICT`, `details.reason governed_subscription_open`) |
| Provider `verify-sign` (`ARAMO_RUN_PACT_PROVIDER=1`) | **1 provider test passed** (all 29 interactions verified). New state `a business tenant holds a governed Aramo-managed Sign subscription` (setup/teardown env; `STRIPE_API_BASE` to a closed local port so no provider call can leave the harness) |
| Consumer `platform-web-consumer` | **37 interactions** (+5: apply allowed 200, `requester_scope_missing` 403, NC-5 `apply_refused` 409, super_admin 403, tenant tier 403) |
| Provider `verify-platform-admin` | **2 provider tests passed** (the CCP route coverage gate over 9 CCP routes, and the verification). States `an approved subscription-open change request exists` and `…whose approver lost eligibility exists`; the verifier now applies the full A6 chain (`applyCcpA6Schema`) |
| Route spec `ccp-a6-commercial-apply-routes.integration.spec.ts` | **2 / 2**: per role — commercial_ops 200 then 200 `replayed`; platform_owner, finance_admin, catalog_manager, support_admin, read_only_auditor 403 `requester_scope_missing`; super_admin 403 at the gate; NC-5 409 `APPROVER_NO_LONGER_ELIGIBLE` (request stays APPROVED); stale 409 `apply_failed` `TARGET_STALE` attempt 1 `APPLY_FAILED`; CREDIT 409 `action_not_applicable`; tenant-tier 403; malformed id 400 |
| `contract-parity:check` | 678 live routes (676 governed), 509 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified (A5: 677; +1 / +1) |
| `openapi:drift-check` | ok (9 files) |
| `redocly lint openapi/platform.yaml`, `openapi/sign.yaml` | valid; 2 and 17 warnings, equal to the baseline counts at `a2468acf` |
| `orphan-scopes:check`, `env:passthrough-check`, `error-codes:check`, `dead-error-codes:check`, `tests:integration:check`, `pg-test-image:check` | ok (no new env var; no new error code; 49 integration roots) |
| `repo-map:generate` / `repo-map:check` | regenerated (3 files modified); ok — run under a temporary `GIT_INDEX_FILE` with intent-to-add entries for the new paths (real index untouched) |
| `nx run-many -t lint -p subscription entitlement sign-service platform-admin common` | 0 errors (pre-existing warnings); ESLint on every changed or new `.ts`: 0 errors, 8 warnings (non-null assertions in test files) |
| `nx run-many -t build -p subscription entitlement common sign-service platform-admin api --skip-nx-cache` | 6 projects + 73 dependency tasks succeeded; `dist/libs/subscription/src/index.d.ts` exports `CommercialApplyService` (HEAD marker checked) |
| `bash scripts/verify-vocabulary.sh` | OK: Tier 1, Tier 2 and front-door clean. No exemption touched. The write hook flagged one Tier-2 token in a test string during authoring; it was removed before any gate run |

`pact/provider/src/verify-api.ts`: **not changed** — no migration changes an apps/api returned shape (A6-H targeted api specs below pass unchanged).

## 8. Tests run and not run

| Suite | Result |
|---|---|
| `libs/subscription` unit + `ARAMO_RUN_INTEGRATION=1`, `--maxWorkers=2` (19 files) | 393 / 394 on the first run; the 1 failure was the A4 source scan counting Pact arbiters (2 → 3, A6 adds the governed fixture on the new arbiter; updated, TD-A6-21); the file re-run: **20 / 20** |
| A6 specs alone (verbose, both files) | **36 / 36** |
| A3 + A4 + lifecycle + eligibility subset | 4 files, **166 / 166** |
| `libs/entitlement` | 27 passed, 5 skipped |
| `libs/common` | 83 passed, 2 skipped |
| `apps/sign-service` unit + integration (33 files) | 361 / 362; the failure was `sign-api.integration.spec.ts` "socket hang up" under load; re-run alone **9 / 9** |
| `apps/platform-admin` unit + integration (19 files, AppModule-booting specs included) | 419 / 420; the failure was `ccp-a1-platform-role-authorization.spec.ts` (400 vs 403 on one route, under load); re-run alone **119 / 119** |
| `apps/api` targeted: `ccp-a4-ats-sign-availability` (ATS golden), `s2-erasure-integrity`, `tenant-reset`, `tr15-b2-erasure`, `portal-p4b-rtbf` (these apply every lib's migrations, A6 included) | **5 files, 35 / 35** |
| Sign allowance / ATS golden equality re-run | `ccp-a4-sign-equality` and `ccp-a5-plan-version` goldens (in the subscription suite), `ccp-a4-ats-sign-consumption` (in the sign-service suite), `ccp-a4-ats-sign-availability` (api): **all equal** |
| **Not run:** the full `nx run api` (instructed); `pact:provider` for `verify.ts` / `verify-api.ts` / `verify-ti.ts` (no contract they verify reads the changed surfaces); `apps/sign-web` tests (one message string added). | — |

Host load: load averages 7 to 13 during the runs.

## 9. Recovery and rollback

- `APPLY_FAILED` is retryable (A6-FAULT-*, A6-G2-2); a failed or refused apply leaves no partial state.
- Code: revert A6-1…A6-8.
- Compensating migration (documented, not shipped; never run against production, PBD §7.5), one transaction:
  ```sql
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM subscription."CommercialChangeApplication")
       OR EXISTS (SELECT 1 FROM subscription."CommercialChangeRequest" WHERE state IN ('APPLYING','APPLIED','APPLY_FAILED') AND action_type IN ('SUBSCRIPTION_OPEN','SUBSCRIPTION_CHANGE','SUBSCRIPTION_END','ENTITLEMENT_GRANT'))
       OR EXISTS (SELECT 1 FROM subscription."BillingReconciliationFlag" WHERE reason = 'governed_subscription_open')
       OR EXISTS (SELECT 1 FROM subscription."SubscriptionVersionPinEvent" WHERE reason = 'CHANGE_REQUEST') THEN
      RAISE EXCEPTION 'CCP-A6 compensation refused: A6 state exists';
    END IF;
  END $$;
  DROP TRIGGER "commercial_change_request_no_applying_commit" ON subscription."CommercialChangeRequest";
  DROP FUNCTION subscription."guard_commercial_change_request_not_applying"();
  DROP TABLE subscription."CommercialChangeApplication";
  DROP FUNCTION subscription."reject_commercial_change_application_mutation"();
  -- restore the CCP-A9 body of guard_commercial_change_request() (A3 base + the A9 role branch)
  ALTER TABLE subscription."BillingReconciliationFlag" DROP CONSTRAINT "BillingReconciliationFlag_reason_check",
    ADD CONSTRAINT "BillingReconciliationFlag_reason_check" CHECK (reason IN ('billing_country_not_supported','domain_not_authoritative'));
  ALTER TABLE subscription."SubscriptionVersionPinEvent" DROP CONSTRAINT "SubscriptionVersionPinEvent_reason_check",
    ADD CONSTRAINT "SubscriptionVersionPinEvent_reason_check" CHECK (reason IN ('PROVIDER_PLAN_CHANGE'));
  ```
- The hold itself is behaviour, not data: reverting A6-4 restores the pre-A6 code (and re-opens O-1; the production release hold C-26…C-28 stands).

## 10. Typed divergences

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| TD-A6-1 | Names fixed | `GOVERNED_SUBSCRIPTION_OPEN` / `governed_subscription_open` / `CHANGE_REQUEST` / `POST …/{id}/apply` (pre-execution record) | Recorded per C-4, C-7(b), O-3 |
| TD-A6-2 | Interpretation | Governed = open BASE `source = 'MANUAL'`. (b) has no rows before B4; (c) ⊆ (a) by construction in A6 | Recorded; B4 must widen `isGovernedSubscription` |
| **TD-A6-3** | Authority choice | No instrument names the **apply** actor. A6: a user holding the action's **requester** scope (the maker executes after the distinct checker chain; the apply adds no authority beyond the approved payload) | **Needs PO / Architect confirmation** |
| TD-A6-4 | Semantics | Authority refusals (NC-5, not approved, integrity, scope) change nothing and write one `…APPLY_REFUSED` audit row (the A3 pattern for refused approvals; A3-NC5-c's "audit count unchanged" was the pure check). Substance failures record `APPLY_FAILED` | Recorded |
| **TD-A6-5** | Gap | An `APPROVED` request never expires (TD-A3-10) and `APPROVED` / `APPLY_FAILED` hold the Q14 slot; there is no withdraw from `APPROVED`. A permanently refused or failing request blocks new requests for that tenant × product | **Needs a ruling** (an abandon transition, or expiry of APPROVED) |
| TD-A6-6 | A3 code change | `assertChainStillSatisfiableAtApply` admits `APPLY_FAILED` (the retry is re-checked like the first attempt) | Recorded |
| TD-A6-7 | Scope boundary | No `TenantEntitlementEvent` (the ledger is A7's per the PBD A7 row; Recon C3 step 6 names it). The entitlement side is recorded in `CommercialChangeApplication.capabilities/_inserted` and `COMMERCIAL_ENTITLEMENT_GRANTED` | For A7 |
| TD-A6-8 | Scope boundary | `SUBSCRIPTION_END` does not revoke capabilities (revoke is A7; C-20) | For A7 |
| TD-A6-9 | Query refinement | C-16(a) is product-scoped (BASE row of the intent plan's product); (b) adds product | Recorded |
| TD-A6-10 | Ordering | The provider billing-account upsert still runs before the authoritative locked check (C-3 constrains the session only); the early read refuses before it in the common case (A6-H-C1: 0 calls) | Recorded |
| TD-A6-11 | Deferred (C2) | No checkout release (C-1 exception, C-12): every such checkout is refused or held | For C2 |
| **TD-A6-12** | Gap | C-8 surfacing to operators is B3 / C6. The tenant billing owner sees "managed by Aramo. Contact Aramo" on a refused checkout, but a **held activation** is not shown on the tenant account view | **Needs a slice assignment** |
| **TD-A6-13** | Scope question | A5 code comments expect A6 to apply `PLAN_VERSION_PUBLISH` / `PLAN_RETIRE` and the v1 price pins; the PBD A6 row lists only MANUAL open / change / end + entitlement grant. Not implemented (like `POLICY_ACTIVATE`, per the lead) | **Lead to rule the owner** |
| TD-A6-14 | Merge | The guard function is the union with the A9 role branch, modelled from the lead's description; A6-only rules are restricted to A6 action types; the TS `COMMERCIAL_TRANSITIONS` table is action-agnostic (the DB is the per-action authority) | Lead diffs against A9 after merge (test A6-SM-A9) |
| TD-A6-15 | Validation | The A6 payload schemas are enforced at create and again at apply (frozen payloads created before A6 fail as `INVALID_PAYLOAD`). 6 A3 test payloads were made valid | Recorded |
| TD-A6-16 | Terms | OPEN sets the commitment from the version's terms; `eligibility_state` is left null (computed by `refreshEligibility`); CHANGE does not re-term the commitment | Recorded |
| TD-A6-17 | Fail-closed choices | A FREE prior row → `TARGET_NOT_REPLACEABLE` (O-4); INACTIVE or FREE plans → `PLAN_NOT_ASSIGNABLE`; a plan `tenant_kind` ≠ tenant kind → refused | Recorded |
| TD-A6-18 | Ruling applied | T8 as §6.1; decision requests DR-A6-1…4 | **For PO / Architect** |
| TD-A6-19 | Idempotency key | The apply is keyed by `change_request_id` (UNIQUE application; replay), not a separate request header | Recorded |
| TD-A6-20 | DTO | `CommercialChangeRequestDto` unchanged (A9 adds `applied_at`); the apply response carries `application` (with `attempt`) | Recorded |
| TD-A6-21 | Spec change | A4 product-dimension spec: a sign checkout over the governed MANUAL fixture is now asserted refused; the isolation proof converts that fixture row to DEVELOPMENT first; the Pact arbiter count is 3 | Recorded |
| TD-A6-22 | Harness | `verify-platform-admin` and the A6 specs use `applyCcpA6Schema` (identity + entitlement + metering + every subscription migration), added to the shared CCP helper | Recorded |
| TD-A6-23 | Migration order | `20261025200000` must sort after A9's `20261025180100` (it does) | Lead checks after merge |
| TD-A6-24 | Merge note | Expected conflicts with A9: `commercial-change-request.ts` (transitions), `commercial-change-request.service.ts`, `subscription.module.ts`, `src/index.ts`, `schema.prisma`, `ccp-a3-database.ts`, the platform-web consumer and `verify-platform-admin.ts`, `openapi/platform.yaml`, `doc/generated/repo-map.*` | For the lead |

## 11. Vocabulary result

`bash scripts/verify-vocabulary.sh`: OK — Tier 1, Tier 2 and front-door retirement clean. No exemption allowlist touched; the Stripe wire exemption (`stripe-wire.ts`) is unchanged and unused by A6.

---

## A6-R — follow-up on the Architect dispositions (2026-10-25)

Governing: `doc/ccp/decisions.md` "Architect dispositions on A6 (2026-10-25)" (binding). Baseline: program HEAD `e0b050ca` (A9, A10 and A6 merged; the lead's merge fixes TD-A6-25 (generic APPLIED-needs-`applied_at`) and TD-A6-26 (`canTransitionFor` per action, A9-U-4 re-based) are kept). **Local commit SHAs: pending (lead commits).** **HALT:** none. TD-A6-5 (apply TTL) was a HALT until the Charter Amendment A1 was LOCKED; it is now implemented (§A6-R.4b).

### A6-R.1 Commit map (proposed)

| # | Proposed commit | Files |
|---|---|---|
| A6R-1 | `CCP-A6-R: apply-time revalidation (original requester, live authority), refusal/failure records with stable codes and explanations` | `libs/subscription/src/lib/commercial/commercial-apply-records.ts` (new); `commercial-apply.service.ts`; `commercial-change-request.service.ts` (`REQUESTER_NO_LONGER_AUTHORIZED`); `apps/platform-admin/src/app/platform/platform-commercial-apply.controller.ts` (`not_requester`, `requester_no_longer_authorized`, `explanation`); `openapi/platform.yaml` |
| A6R-2 | `CCP-A6-R: DR-A6-1…4 usage rules (USAGE_EXCEEDS_NEW_LIMIT, USAGE_CROSS_PERIOD, RESERVATION_CONFLICT, FUTURE_EFFECTIVE_DATE)` | `commercial-apply.service.ts` (`changedTerms`, `assertUsageFits`, `assertNoStrandedUsage`) |
| A6R-3 | `CCP-A6-R: tenant-facing pending activation state (Conversion Rule C-8)` | `libs/subscription/src/lib/billing/subscription-lifecycle.service.ts` (`tenantActivationState`), `src/index.ts`; `apps/sign-service/src/app/billing/esign-billing.controller.ts` (`pending_activation`); `openapi/sign.yaml`; `pact/consumers/sign-workspace-consumer/…` (+1 interaction), `pact/provider/src/verify-sign.ts` (state) |
| A6R-4 | `CCP-A6-R: tests` | `libs/subscription/src/tests/ccp-a6-apply.integration.spec.ts`, `ccp-a6-hold.integration.spec.ts`, `support/ccp-a6.ts`; `apps/platform-admin/src/tests/ccp-a6-commercial-apply-routes.integration.spec.ts`; `apps/sign-service/src/tests/billing.spec.ts`; `pact/consumers/platform-web-consumer/…` (not_requester), `pact/provider/src/verify-platform-admin.ts` |
| A6R-6 | `CCP-A6-R: apply deadline (Charter Amendment A1): APPLY_EXPIRED, apply_expiry_hours, lazy expiry` | `libs/subscription/prisma/migrations/20261026050000_ccp_a6r_apply_deadline/migration.sql` (new); `schema.prisma` (comment); `commercial-policy.ts` (optional key); `commercial-change-request.ts` (state, transitions); `commercial-change-request.service.ts` (`applyDeadlineOf`, `expireApplyIfDue`, lazy read / create expiry, `apply_actionable`); `commercial-apply-records.ts` (`applyDeadlineGate`); both apply services; the apply controller (`apply_expired`); `openapi/platform.yaml`; tests `ccp-a6r-apply-deadline.integration.spec.ts` (new), `commercial-policy.spec.ts`, `commercial-approval-eligibility.spec.ts`, `ccp-a9-role-change.spec.ts` |
| A6R-7 | `CCP-A6-R: requester-only apply (TD-B2-3) and apply_actionable on the request read` | `commercial-change-request.service.ts` (`applyActionable`); `platform-commercial-change-request.controller.ts`, `dto/commercial-change-request.dto.ts`; `openapi/platform.yaml`; the platform-web consumer; tests A6R-REQ-1…3 |
| A6R-5 | `CCP-A6-R: acceptance evidence (this section)` + repo map | `doc/ccp/slices/CCP-A6-acceptance.md`; `doc/generated/repo-map.*` |

CCP-B2-backend rows are in `doc/ccp/slices/CCP-B2-backend-acceptance.md`.

### A6-R.2 TD-A6-3 (approved): apply-time revalidation

| Check | Where | Typed refusal | Test |
|---|---|---|---|
| A person, not a service principal | `preflightApply` | `NOT_HUMAN` | A6-AUTH-1, B2-AUTH-1 |
| **The original requester** (approval and application are separate authorities) | `preflightApply` (`actor = requested_by`) | `NOT_REQUESTER` (**new behaviour**; A6 previously admitted any holder of the requester scope) | A6-AUTH-1, A6-RI-APPLY, B2-AUTH-1, Pact |
| The requester scope on the session | `preflightApply` | `REQUESTER_SCOPE_MISSING` | A6-AUTH-1, B2-AUTH-1 |
| The requester's **current** authority (live RBAC, `FOR SHARE`, in the apply transaction) | `assertRequesterStillAuthorized` | `REQUESTER_NO_LONGER_AUTHORIZED` (**new code**) | A6R-REV-1 |
| Request state | `assertApplyEligible` | `NOT_APPROVED` | A6-AUTH-1, B2-AUTH-1 |
| Approval validity: every step, distinct signers, NC-3 stale chain / NC-4 approver eligibility re-read in the transaction (role, scopes, D9 attestation) | `assertApplyEligible` | `APPROVALS_INCOMPLETE`, `APPROVER_NOT_DISTINCT`, `APPROVER_NO_LONGER_ELIGIBLE` | A6-NC5-a (role revoked), **A6R-REV-2** (attestation revoked), A6-NC5-c |
| Eligibility and the current target subscription state | the A6 guards (G1/G2/G3, T2) | `STRIPE_OWNED`, `TARGET_STALE`, `TARGET_NOT_FOUND`, `TARGET_NOT_GOVERNED`, `PLAN_*`, `TENANT_NOT_FOUND` | A6-G1-1, A6-G2-2, A6-G3-1, A6-END-1 |
| Idempotency | replay of an APPLIED request; UNIQUE application per request | — | A6-IDEM-1, A6-CONC-1 |
| **Payload bound to its checksum**; any change needs a new approval | the A3 immutability trigger + `verifyIntegrity` | `INTEGRITY` | **A6R-REV-3** (UPDATE of payload and of the checksum refused by the DB; a superuser bypass refused at apply) |

**Every refusal** writes exactly one `COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED` audit row with the code and an operator-facing `explanation`, changes nothing, and is returned with `details.explanation` (A6-AUTH-1 asserts 4 rows `NOT_REQUESTER`, `REQUESTER_SCOPE_MISSING`, `NOT_HUMAN`, `INTEGRITY`, each with an explanation). Pre-transaction refusals are now audited too. `NOT_FOUND` has no request to attach a row to (the audit FK) and is not audited. **Every failure** writes one `…APPLY_FAILED` row with code and explanation (A6R-DR-2/4).

### A6-R.3 DR-A6-1…4 (usage)

| Disposition | Implemented | Stable code | Test |
|---|---|---|---|
| **DR-A6-1** downgrade: refuse where consumed + reserved exceeds the new limit | lowered allowance, capacity and short-window terms are checked against consumed + RESERVED usage of the current period (capacity: ACTIVE storage; window: the day window), each under the same advisory lock the reserve path takes | `USAGE_EXCEEDS_NEW_LIMIT` (`details.exceeded` lists term, used, new limit) | A6-T8-2 / A6R-DR-1: 200 → 100 with 60 + 30 = 90 → applied, `limit 100, used 90, remaining 10`, ledger byte-identical; 80 + 30 = 110 → refused, nothing changed; exactly 100 = 100 → applied, remaining 0 |
| **TD-A6-R-1** (interpretation, recorded) | a same-period downgrade where consumed + reserved ≤ the new limit is admissible, carrying usage exactly as the T8 upgrade rule does; no reset, no forgiveness, no negative allowance. No LOCKED text contradicting it was found (the Conversion Rule, MP-A2 N-13…N-19, Charter §7 and the PBD A6 row are silent on downgrades) | — | as above |
| **DR-A6-2** cross-period: fail closed | a replacement with a different anchor; a fresh open that would strand recorded consumption | `USAGE_CROSS_PERIOD` | A6R-DR-2/4 |
| **DR-A6-3** reservations: preserve every valid reservation; refuse invalidation / double consumption | the blanket open-reservation refusal is **removed**: reservations stay counted and untouched when the change fits; a fresh open that would strand valid reservations is refused | `RESERVATION_CONFLICT` | A6R-DR-3 (upgrade with 5 reservations: ledger byte-identical, `used 5` under the new limit); stranded reservations refused, nothing changed |
| **DR-A6-4** future effective date: fail closed; never APPLIED early; no scheduler | | `FUTURE_EFFECTIVE_DATE` | A6R-DR-2/4 (request APPLY_FAILED, no row) |
| (no treatment defined) | a version that drops an allowance or changes its period kind | `USAGE_TREATMENT_UNDEFINED` | A6R-DR-2/4 |

### A6-R.4 TD-A6-12 (approved with clarification): the tenant-facing state

The Conversion Rule covers the tenant surface: **C-8** (`Aramo/locked/Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED.md:130`): "It MUST also be surfaced to the tenant's billing owner as 'held, contact Aramo'." So it is built (TD-A6-R-2 not needed):

- `SubscriptionLifecycleService.tenantActivationState(tenant, product)` (read-only) returns `{ state: 'PENDING', message: 'Subscription activation pending — contact support' }` while a `governed_subscription_open` hold is open for a checkout of that product, else `null`.
- `GET /v1/sign/billing/account` adds `pending_activation` (sign-service). The account read is otherwise unchanged: it reports the governed subscription as it is and never an activation. No flag, reason or contract detail is exposed; the MANUAL row is never touched. Operators keep the detail (flags, events).
- Tests: A6R-HOLD-1 (held → pending; the copy contains no internal term; the MANUAL row byte-identical; a webhook-confirmed end clears it), A6R-SIGN-1 (controller: the pending state only, no internal terms), Pact (sign-workspace +1 interaction, `verify-sign`).
- **TD-A6-R-3:** the copy follows the Architect disposition ("Subscription activation pending — contact support"); C-8 quotes "held, contact Aramo". The meaning is the same (held/pending; contact Aramo support). Flagged for the lead, not a HALT.

### A6-R.4a Second disposition (Architect / PO, 2026-10-25)

**TD-A6-R-1 CONFIRMED.** A same-period downgrade applies only when consumed + outstanding reservations ≤ the new allowance. It is revalidated atomically at apply, under the billing lock and the per-key reservation lock, in the apply transaction. No reset, no proration. Each usage row is one send key (`AllowanceUsage` is UNIQUE per tenant × key × send_key), so consumed and reserved never overlap: a reservation that is consumed is the same row. Tests (A6-T8-2 / A6R-DR-1):
- **the Architect's example:** 200 → 100 with 70 consumed + 10 reserved → applied, `limit 100, used 80, remaining 20`, ledger byte-identical;
- **boundary:** 90 + 10 = 100 → applied, remaining 0;
- **exceed:** 80 + 30 = 110 → `USAGE_EXCEEDS_NEW_LIMIT`, nothing changed.

Cross-period, proration and future-dated changes stay refused (A6R-DR-2/4).

**TD-B2-3: apply is REQUESTER-ONLY in v1.**
- **Refusal:** any actor other than `requested_by` is refused `NOT_REQUESTER`, with one `COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED` row. This holds even when the actor holds the requester scope or approved the request.
- **A6R-REQ-1:** another commercial_ops user, the approver (finance_admin) and a super_admin user, each called at the service, each refused `NOT_REQUESTER` with one row; nothing changes; the requester then applies.
- **HTTP:** a super_admin is refused 403 at the route gate (no `platform:approval:read`) before the service. That is an authorization-gate refusal, as on every CCP route (A6-RI-APPLY).
- **The read exposes `apply_actionable`** (`GET /platform/commercial/change-requests/{id}`). It is true only for the requester of an APPROVED / APPLY_FAILED request whose action the governed apply covers, while the session holds the requester scope (A6R-REQ-2: DRAFT, PENDING, approver, other requester-scope holder and scope-less session are all false; APPLIED is false).
- **Contract changes:** OpenAPI `CommercialChangeRequestDetail.apply_actionable` (required). Pact: platform-web +2 interactions (requester true, approver false), plus `apply_actionable: false` on the pending detail read; `verify-platform-admin` green.

**Early refusals are audited (lead item, from A8 verification).** Every apply refusal writes exactly one audit row of event type **`COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED`**, payload `{ action_type, refusal, explanation, detail, actor_kind }`. This includes the checks that run before the apply transaction (not human, not applicable, `NOT_REQUESTER`, requester scope), which are written in a separate short transaction. An expiry triggered by the apply itself writes its one `COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED` event instead (AD-6). A6R-REQ-3: finance_admin applying a support_admin `SUPPORT_EXTENSION` request writes exactly one row.
- In this tree, SUPPORT_EXTENSION has no governed apply, so the code is `ACTION_NOT_APPLICABLE`.
- Once A8's apply path is merged, the same preflight yields `NOT_REQUESTER`, because the requester check comes before the scope check.

### A6-R.4b Apply deadline (Charter Amendment A1, LOCKED; `Aramo-CCP-Charter-Amendment-A1-Apply-Deadline-v1_0-LOCKED.md`, SHA-256 prefix `58dac8ed94ccf43b`)

TD-A6-5 was a HALT; the amendment now LOCKs it, and the earlier no-op seam is replaced by the implementation.

| Rule | Implemented | Test |
|---|---|---|
| AD-1 the value is policy data | optional key **`apply_expiry_hours`** (named after `approval_expiry_hours`) in `commercial-policy.ts` (`COMMERCIAL_POLICY_OPTIONAL_KEYS`). v1 is unchanged (same shape, same checksum). A declared malformed key fails the whole document closed. **No policy version is seeded**: v2 arrives through POLICY_ACTIVATE (B5); the tests use a fixture v2 | A6R-POL-1…3 (unit); A6R-TTL-MAL (a malformed ACTIVE version: create fails closed `MALFORMED`) |
| AD-2 snapshot | the deadline is read from the request's own `policy_version_id` (checksum re-verified). v1 → no deadline | **A6R-TTL-V1**: 10 000 h after approval, still APPROVED and applied |
| AD-3 half-open boundary | authority while `approved_at ≤ t < approved_at + apply_expiry_hours` | **A6R-TTL-B**: deadline − 1 ms applies; exactly at the deadline → `APPLY_EXPIRED` |
| AD-4 terminal `APPLY_EXPIRED`, only from APPROVED / APPLY_FAILED, never APPLYING; a retry only before the deadline | state + CHECK widening (additive) + guard block (migration `20261026050000_ccp_a6r_apply_deadline`); `canTransitionFor` / `COMMERCIAL_A6_APPLY_TRANSITIONS`; A6-SM-1 (12 of 100 pairs) and A9-U-4 mirror it | A6R-TTL-R (retry admitted before; APPLY_FAILED → APPLY_EXPIRED at the deadline); **A6R-TTL-DB** (APPLYING → APPLY_EXPIRED refused; terminal; a CREDIT cannot reach it; CHECK contains the value) |
| AD-5 slot release | not an open state (the Q14 index lists the open states) | A6R-TTL-B, A6R-TTL-CREATE (admitted after; `OPEN_REQUEST_EXISTS` before) |
| AD-6 history; one event | only `state` / `updated_at` change; one `COMMERCIAL_CHANGE_REQUEST_APPLY_EXPIRED` event (from state, final approval, deadline, check instant); a later apply of the expired request is a separate audited refusal | A6R-TTL-B |
| AD-7 lazy, at apply, create contention and read; stable code | apply: `applyDeadlineGate` (both the A6 and the catalog apply) → `APPLY_EXPIRED` (409 `apply_expired`); create: `expireOpenFor` (same tenant × product); read: `get` and `list`. No sweep worker | A6R-TTL-B, A6R-TTL-CREATE, **A6R-TTL-READ**, **A6R-TTL-B2** (catalog apply) |
| AD-8 apply authority | the requester-only rule, the immutable payload, the approved state, the unexpired authority and current eligibility are all checked (§A6-R.2) | as above |

The guard migration keeps the current function body (A3 ∪ A9 ∪ A6 ∪ B2) verbatim and adds two clearly delimited `CCP-A6-R apply deadline` blocks (for the lead's union with A8's `20261026010000` EXCEPTION branch at merge).

**Compensating migration (documented, not shipped):** RAISE if any request is APPLY_EXPIRED; restore the `20261025220000` body of `guard_commercial_change_request()`; restore the previous state CHECK.

### A6-R.5 Test, Pact and gate outputs

All runs are on the final state, after the Docker daemon restart (the lead reported a hang from about 08:50; nothing below is from the outage).

| Run | Result |
|---|---|
| A6 / hold / B2 / apply-deadline specs (`ccp-a6-apply` 34, `ccp-a6-hold` 11, `ccp-b2-catalog-apply` 6, `ccp-a6r-apply-deadline` 8) | **4 files, 59 / 59** |
| `libs/subscription` unit + `ARAMO_RUN_INTEGRATION=1` | **23 files, 450 / 450** |
| `apps/platform-admin` unit + integration (AppModule-booting specs included) | **21 files, 451 / 451** |
| `apps/sign-service` unit + integration (after the `pending_activation` change; no sign-service change since) | **33 files, 363 / 363** |
| `apps/api` targeted (`ccp-a4-ats-sign-availability`, `s2-erasure-integrity`, `tenant-reset`, `tr15-b2-erasure`, `portal-p4b-rtbf`; they apply every lib's migrations, both new ones included) | **5 files, 35 / 35** |
| Pact consumers (pact files regenerated from empty: PactV4 merges into an existing file, so a stale renamed interaction had survived once and was removed) | `sign-consumer` 11, `sign-web-consumer` 6, `sign-workspace-consumer` 13 (+1 `pending_activation`), `platform-web-consumer` 40 interactions (39 tests; +1 catalog publish, +2 `apply_actionable`, the not-requester refusal renamed) |
| Pact provider `verify-sign` (`ARAMO_RUN_PACT_PROVIDER=1`) | **1 provider test passed** (30 interactions) |
| Pact provider `verify-platform-admin` | **2 provider tests passed** (the CCP route coverage gate and the verification of 40 interactions) |
| `nx run-many -t build -p subscription entitlement common sign-service platform-admin api --skip-nx-cache` | 6 projects + 73 dependency tasks |
| `nx run-many -t lint -p subscription sign-service platform-admin` | 0 errors (warnings only) |
| `contract-parity:check` | 678 live routes (676 governed), 509 OpenAPI ops, 0 orphan, 0 unclassified (no new route) |
| `openapi:drift-check`, `orphan-scopes:check`, `env:passthrough-check`, `error-codes:check`, `dead-error-codes:check`, `tests:integration:check`, `pg-test-image:check` | ok |
| `redocly lint` platform + sign | valid; 2 + 17 warnings (the baseline counts) |
| `repo-map:generate` / `repo-map:check` | regenerated; ok (temporary `GIT_INDEX_FILE`) |
| `scripts/verify-vocabulary.sh` | OK (the write hook caught one Tier-2 token in a comment during authoring; it was reworded before any gate run) |

**Not run:** the full `nx run api` (instructed). `verify-api.ts` is not changed: no apps/api returned shape changed.

### A6-R.6 Typed divergences

| ID | Divergence | Disposition |
|---|---|---|
| TD-A6-R-1 | The DR-A6-1 interpretation above | Recorded per the lead's instruction |
| TD-A6-R-3 | Tenant copy vs C-8 wording | For the lead |
| TD-A6-R-4 | Apply is now restricted to the original requester (`NOT_REQUESTER`), per the TD-A6-3 approval text. The platform-web Pact refusal interaction changed from `requester_scope_missing` to `not_requester` | Recorded |
| TD-A6-R-5 | Pre-transaction refusals (not human, not applicable, not the requester, scope) are now audited (one row each); `NOT_FOUND` is not (no request row for the audit FK) | Recorded |
| TD-A6-R-6 | The refusal and failure recording moved to `commercial-apply-records.ts`, shared with the CCP-B2-backend apply; `CommercialApplyFailedError` is re-exported from `commercial-apply.service.ts` unchanged in shape (plus `explanation`) | Recorded |
| TD-A6-R-7 | The apply response gains `catalog_application` (null for A6 actions) and `application` becomes nullable (null for a catalog apply); OpenAPI updated | Recorded |
| TD-A6-R-8 | TD-A6-5 apply TTL: built per the LOCKED Charter Amendment A1 (§A6-R.4b); the HALT is discharged | Implemented |
| TD-A6-R-9 | The apply deadline gates the governed apply's action types (A6, B2). The CCP-A9 role-change apply path is not wired to the deadline in this tree (A9's own service); the guard does not admit APPLY_EXPIRED for role actions | **For the lead** (A9 path or a ruling) |
| TD-A6-R-10 | A malformed or unreadable policy snapshot fails closed at apply (`INTEGRITY` refusal); a read never fails on it (the request is shown as stored) | Recorded |
| TD-A6-R-11 | The expiry time is recorded in the audit event and `updated_at`; no new column (a new column would break every spec that selects the request through Prisma without this migration) | Recorded |
