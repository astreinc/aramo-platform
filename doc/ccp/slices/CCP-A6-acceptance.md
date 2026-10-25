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
