# CCP-A8 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.1 A8 row. Governing instruments: DDR v1.2 §3.2 item 5 (`Aramo-Authorization-Model-DDR-Amendment-v1_2-CCP-Commercial-Authority-LOCKED.md:106`), Charter §7 (D5), A1 directive `:115` (`platform:subscription:support` = support_admin), `doc/ccp/decisions.md` A2-B, TD-A2-1, **Q7**, TD-A3-2, TD-A3-0 (NC-5), T1–T12 and the T8 usage rule; the Recon Report §1 C1 and G1.

| | |
|---|---|
| **Slice** | CCP-A8: support exception overlay |
| **Branch / baseline** | `wip/ccp-a8` at `078d4f78` (A1–A6, A9, A10). Pre-execution record: `doc/ccp/slices/CCP-A8-pre-execution.md` |
| **Local commit SHAs** | **pending (lead commits).** Nothing committed or pushed by the executor. |
| **HALT conditions hit** | **None.** No A8 path writes a Stripe-owned row, or any `TenantSubscription` row: proven by a tripwire trigger that raises on every UPDATE or DELETE of a Stripe-owned row, live for the whole A8 integration spec (A8-G1-1). |

## 1. Commit map (proposed; SHAs pending, lead commits)

| # | Proposed commit | Files |
|---|---|---|
| A8-0 | `CCP-A8: pre-execution check` | `doc/ccp/slices/CCP-A8-pre-execution.md` (new) |
| A8-1 | `CCP-A8: support extension overlay migration (SupportExtension; guard = A6 body + A8 branch; application CHECK widened) and Prisma model` | `libs/subscription/prisma/migrations/20261026010000_ccp_a8_support_extension_overlay/migration.sql` (new); `libs/subscription/prisma/schema.prisma` |
| A8-2 | `CCP-A8: pure model (payload schema, BOUNDED_EXCEPTION chain, kind-aware transitions, bound + eligibility decision, overlay window)` | `libs/subscription/src/lib/commercial/support-extension.ts` (new); `commercial-change-request.ts` |
| A8-3 | `CCP-A8: reuse the A6 apply (completeInTx, applyBoundedExceptionInTx, the SUPPORT_EXTENSION domain step) and the SupportExtensionService` | `libs/subscription/src/lib/commercial/support-extension.service.ts` (new); `commercial-apply.service.ts`, `commercial-change-request.service.ts` (`expireOpenFor` public), `subscription.module.ts`, `src/index.ts` |
| A8-4 | `CCP-A8: the allowance reader honours an unremoved overlay of a PAST_DUE row (T8: window only)` | `libs/subscription/src/lib/allowance.service.ts` |
| A8-5 | `CCP-A8: support-extension routes, OpenAPI and gates` | `apps/platform-admin/src/app/platform/platform-commercial-support-extension.controller.ts`, `dto/support-extension.dto.ts` (new); `platform.module.ts`; `openapi/platform.yaml`; `ci/config/api-surface-manifest.json`; `ci/scripts/verify-orphan-scopes.ts` |
| A8-6 | `CCP-A8: tests (bound, breach, boundary, apply, removal, guard, routes) and the shared helpers; A3/A6/A9 spec adjustments` | new: `libs/subscription/src/tests/ccp-a8-support-extension.spec.ts`, `ccp-a8-support-extension.integration.spec.ts`, `fixtures/ccp-a8.ts`, `apps/platform-admin/src/tests/ccp-a8-support-extension-authorization.spec.ts`, `ccp-a8-support-extension-routes.integration.spec.ts`; modified: `libs/subscription/src/tests/support/ccp-a6.ts`, `ccp-a9-role-change.spec.ts` (A9-U-4), `commercial-approval-eligibility.spec.ts` (A6-SM-1), `subscription-lifecycle.integration.spec.ts`, `ccp-a4-sign-equality.integration.spec.ts`, `ccp-a5-plan-version.integration.spec.ts`, `apps/api/src/tests/ccp-a4-ats-sign-availability.integration.spec.ts`, `apps/platform-admin/src/tests/ccp-a3-commercial-change-request-routes.integration.spec.ts` |
| A8-7 | `CCP-A8: Pact — the support-extension routes (platform-web / verify-platform-admin)` | `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts`; `pact/provider/src/verify-platform-admin.ts` |
| A8-8 | `CCP-A8: acceptance evidence` + `CCP-A8: regenerate repo map` | `doc/ccp/slices/CCP-A8-acceptance.md` (new); `doc/generated/repo-map.{coupling,files,projects}.json` |

Totals: **12 new files, 24 modified files (36 paths)**. **Unchanged:** every existing migration (the A6 guard and its constraint trigger are not edited; A8 re-creates the function in its own migration); `pact/provider/src/verify-api.ts` (no apps/api returned shape changes, §7); `doc/ccp/decisions.md`; `subscription-lifecycle.service.ts` (the webhook / checkout path).

## 2. Design as implemented

**What an extension extends.** The **sending window of one PAST_DUE subscription row**, as an overlay row `subscription."SupportExtension"`: `base_until = max(applied_at, grace_until at apply)`, `extends_until = base_until + days` (both CHECKed; seconds arithmetic, no DST drift). `AllowanceService.activePlan` (`allowance.service.ts`) keeps the pre-A8 rule and adds one branch: a PAST_DUE row past grace still sends while an **unremoved** overlay of **that row** has `extends_until > at` (half-open, TD-A2-1). Limit, period and counted usage are the row's own, so no allowance is manufactured (T8). The subscription row is never written (Recon G1).

**Bounded path** (`POST /platform/commercial/support-extensions`, gate `platform:subscription:support`). `SupportExtensionService.request`, in ONE transaction:
1. `takeBillingLock(tenant)` (the A6 helper; the webhook, checkout and apply take the same lock) plus the A3 Q14 advisory lock;
2. refusals (tenant, Q14 open request, the named row is the open BASE row of tenant × product);
3. reads every prior overlay of tenant × product and the requester's live D9 attestation; `decideSupportExtension` = the A2 pure `checkSupportExtension` (LENGTH, FREQUENCY, CUMULATIVE over the ACTIVE policy) plus ELIGIBILITY (`SUBSCRIPTION_NOT_PAST_DUE`, `REQUESTER_NOT_ATTESTED`);
4. **in bounds:** inserts a `SUPPORT_EXTENSION` request of **kind `EXCEPTION`** with the zero-step `BOUNDED_EXCEPTION` chain (basis = the clause and the counter snapshot), then `CommercialApplyService.applyBoundedExceptionInTx`: `DRAFT → APPLYING` (attempt 1), then the **same A6 core** (`completeInTx`) as an approved apply: the domain step writes the overlay, the `CommercialChangeApplication`, the audit events, then `APPLIED`. Every audit event of the request carries `is_exception = true`: `COMMERCIAL_CHANGE_REQUEST_CREATED`, `SUPPORT_EXTENSION_EXCEPTION_APPLIED` (with the counter snapshot), `COMMERCIAL_CHANGE_REQUEST_APPLIED` (with `exception.zero_approvals`, clause, counters).
5. **any breach → escalates:** nothing is written in that transaction. The A3 service then creates and submits a NORMAL `SUPPORT_EXTENSION` request (Finance-only chain, Q7), and a `SUPPORT_EXTENSION_ESCALATED` event records the breaches. **Nothing applies.**

**Escalated apply and removal reuse A6 as is.** `CommercialApplyService.apply` admits `SUPPORT_EXTENSION` of kind NORMAL. It runs the A6 path unchanged: billing lock, `FOR UPDATE`, NC-5 `assertApplyEligible`, `APPLYING`, domain, application, audit, `APPLIED`, and `APPLY_FAILED` retry. The apply authority is the requester scope (TD-A6-3), here `platform:subscription:support`. **Removal** is a `SUPPORT_EXTENSION` request with payload `{operation: REMOVE, support_extension_id}` through the existing change-request routes: Finance-only chain, then applied by `…/apply`. It records the single removal (`removed_at`, `removed_by`, `remove_change_request_id`). A bounded EXCEPTION request is refused by `…/apply` (`action_not_applicable`).

**How A6 is reused, not forked.** `apply()` steps 5–8 moved verbatim into the private `completeInTx(…, exception | null)`. Two things call it: `apply()` (approved path; `exception = null`) and `applyBoundedExceptionInTx` (the A8 entry, inside the caller's transaction). `applyDomain` gained a `SUPPORT_EXTENSION` case (`supportExtensionEffect`). The admission check moved from `isA6Applicable` to `isApplyServiceAction` (A6 ∪ SUPPORT_EXTENSION). `CommercialChangeApplication` records both A8 applies (its action CHECK is widened, capabilities `[]`). `takeBillingLock` is the A6 helper. All A6 specs pass unchanged (§6).

**DB backstops** (migration `20261026010000`):
- `guard_commercial_change_request()` is re-created with the **A6 body verbatim**, plus one A8 branch. In it, a `SUPPORT_EXTENSION` of kind EXCEPTION makes exactly `DRAFT → APPLYING → APPLIED`, with the zero-step `BOUNDED_EXCEPTION` chain and zero approvals. A NORMAL one takes the A6 set. Both follow the A6 `apply_attempts` / `applied_at` rules. `APPLIED` needs the application row and the overlay effect.
- `SupportExtension` INSERT needs its `SUPPORT_EXTENSION` (EXTEND) request in APPLYING, matching tenant, product, row and days. UPDATE allows one removal only, by an applying REMOVE request naming the row. DELETE is rejected.
- Two new deferred constraint triggers: a SUPPORT_EXTENSION request never commits in APPLYING (this reuses the A6 function), and a bounded EXCEPTION commits only as APPLIED. The A6 constraint trigger is untouched.

**TS mirror.** `canTransitionFor(action, from, to, kind = 'NORMAL')`. `SUPPORT_EXTENSION` + `EXCEPTION` gives exactly the two bounded moves. `SUPPORT_EXTENSION` NORMAL gives the A3 base plus the A6 set. The action-agnostic `COMMERCIAL_TRANSITIONS` gains `DRAFT → APPLYING`. **A9-U-4** is re-based and pins all three. **A6-SM-1** now counts 11 pairs (was 10).

## 3. Bound, breach and boundary test outputs

**Pure table**, `libs/subscription/src/tests/ccp-a8-support-extension.spec.ts`, **34 / 34**. The policy is the v1 document parsed from the A2 migration. Time steps are 1 ms; day steps are 1 day.

| Rule | Exact | Just-below | Just-above | IDs |
|---|---|---|---|---|
| Length ≤ 14 in bounds | 14 → **applies** | 13 → applies | 15 → **escalates** `LENGTH` | A8-B-LEN-1…4 |
| Frequency: none in the rolling 90 days (half-open) | prior 90 d old → **applies** (aged out) | 90 d − 1 ms → **escalates** `FREQUENCY` | 90 d + 1 ms → applies | A8-B-FREQ-1…3; a future-dated prior counts (A8-B-FREQ-5) |
| Cumulative ≤ 30 in rolling 365 days (inclusive cap) | 14 + 14 + 2 = 30 → **applies** | 29 → applies | 31 → **escalates** `CUMULATIVE` | A8-B-CUM-1…3 |
| Cumulative window edge (a 14-day prior) | 365 d old → aged out (17) | 365 d − 1 ms → counts (31, escalates) | 365 d + 1 ms → aged out (17) | A8-B-CUM-4…6 |
| Eligibility | ACTIVE / TRIALING / INCOMPLETE / CANCELED row → `ELIGIBILITY` + `SUBSCRIPTION_NOT_PAST_DUE`; unattested requester → `REQUESTER_NOT_ATTESTED` | | | A8-B-ELIG-1, -2 |
| All together | `[LENGTH, FREQUENCY, CUMULATIVE, ELIGIBILITY]`, counters `{15, 1, 28, 43}`, clause `{14, 90, 30, 365}` | | | A8-B-ELIG-3 |

Also: window start = grace_until when grace is still running, else the apply instant (A8-W-1, -2); coverage is half-open and removal ends it (A8-W-3); payload schema (A8-PL-1, A8-PL-2.1…2.8); chains Q7 / removal and the zero-step chain round-trip (A8-CH-1, -2).

**Through the real path on Postgres 17**, `libs/subscription/src/tests/ccp-a8-support-extension.integration.spec.ts`, **18 / 18** (after the Docker restart; §6):

| Obligation | Test ID | Output |
|---|---|---|
| **In bounds applies with `is_exception = true`** | A8-APPLY-1 | 14 days on a Stripe-owned PAST_DUE row: request `kind EXCEPTION`, `APPLIED`, attempt 1, chain `BOUNDED_EXCEPTION` with `steps: []`, **0 approval rows**; overlay `is_exception: true`, `extends_until = T0 + 14 d`; application `SUPPORT_EXTENSION`, `capabilities: []`; events `CREATED`, `SUPPORT_EXTENSION_EXCEPTION_APPLIED`, `APPLIED`, **all `is_exception = true`**; counters `{14, 0, 0, 14}`; Stripe row `row_to_json` byte-identical |
| T8 | A8-T8-1 | during the overlay, `getStatus` equals that of an ACTIVE twin on the same plan with the same usage (limit, used, remaining, period); usage ledger byte-identical; sends at `extends_until − 1 ms`, `PAST_DUE` not sending at `extends_until` |
| Window from grace | A8-APPLY-2 | grace in 2 days → `base_until = grace_until`, `extends_until = grace + 5 d` |
| **Length breach escalates, never applies** | A8-ESC-LEN-1 | 15 days → `ESCALATED`; NORMAL `PENDING_APPROVAL`, `FINANCE_ONLY` (Q7); 0 overlays, 0 applications; still not sending; events `CREATED`, `SUBMITTED`, `SUPPORT_EXTENSION_ESCALATED` (`breaches [LENGTH]`, `applied: false`), none `is_exception` |
| **Frequency boundary** | A8-ESC-FREQ-1 | prior exactly 90 d → `APPLIED` (2 overlays); 90 d − 1 ms → `ESCALATED [FREQUENCY]` (1 overlay); 90 d + 1 ms → `APPLIED` |
| **Cumulative boundary** | A8-ESC-CUM-1 | 14 + 14 (300 d, 200 d ago) + 2 → `APPLIED` (30); + 3 → `ESCALATED [CUMULATIVE]` (31), 2 overlays |
| **Eligibility breaches** | A8-ESC-ELIG-1 | ACTIVE row → `ESCALATED [ELIGIBILITY] / SUBSCRIPTION_NOT_PAST_DUE`; unattested support_admin → `ESCALATED [ELIGIBILITY] / REQUESTER_NOT_ATTESTED`; 0 overlays; not sending |
| Escalated → approved → applied (A6 path) | A8-ESC-APPLY-1 | finance_admin applying → `REQUESTER_SCOPE_MISSING`; support_admin → `APPLIED`; overlay `is_exception: false`, `SUPPORT_EXTENSION_APPLIED`; Stripe row byte-identical; replay `replayed: true`, still 1 overlay |
| NC-5 at apply | A8-ESC-NC5-1 | signer's finance_admin role revoked → `REFUSED:APPROVER_NO_LONGER_ELIGIBLE`; 0 overlays; request stays `APPROVED` |
| Stale target | A8-ESC-STALE-1 | the row ended after approval → `FAILED:TARGET_STALE` (APPLY_FAILED, retryable), 0 overlays |
| **Recovery: removable by change request** | A8-REMOVE-1 | REMOVE request (`FINANCE_ONLY`, basis `TD-A8 support extension removal`) → approved → applied: `removed_at` = apply instant, `removed_by` support_admin; stops sending; `SUPPORT_EXTENSION_REMOVED`; a second removal → `FAILED:EXTENSION_ALREADY_REMOVED`; Stripe row byte-identical |
| Refusals write nothing | A8-REFUSE-1 | `REQUESTER_SCOPE_MISSING` (commercial_ops), `NOT_HUMAN`, `platform_tenant`, `TENANT_NOT_FOUND`, `subscription_not_open` (another tenant's row; an ended row), `invalid_payload` (0 days): request / application / overlay / audit counts unchanged; Q14: with an escalated request open → `OPEN_REQUEST_EXISTS`, counts unchanged |
| Idempotency | A8-IDEM-1 | replay → `replayed: true`, same request, counts unchanged; same key, other body → `IDEMPOTENCY_KEY_CONFLICT` |
| Concurrency | A8-CONC-1 | 4 concurrent in-bound calls for one tenant: exactly 1 `APPLIED`, ≤ 1 `ESCALATED`, the rest `OPEN_REQUEST_EXISTS`; exactly 1 overlay |
| Billing lock | A8-LOCK-1 | while a session holds `billing:<tenant>` the call waits (advisory waiter observed, 0 overlays); on release → `APPLIED` |
| Overlay triggers | A8-TRG-1 | raw INSERT without an applying request, UPDATE of `extends_until`, a removal without an applying REMOVE request, DELETE: all raise; the APPLIED request is frozen |
| Guard | A8-TRG-2 | EXCEPTION committed in DRAFT → `can commit only as APPLIED`; EXCEPTION `DRAFT → PENDING_APPROVAL` → refused; `APPLIED` without its application → refused; EXCEPTION with a non-empty chain → refused at APPLYING; NORMAL `DRAFT → APPLYING` → refused |
| **G1 (HALT condition)** | A8-G1-1 | the tripwire is live (a direct write raises `A8 TRIPWIRE: UPDATE`); every test above ran under it |

## 4. Per-role matrix (6 roles + super_admin)

Gate spec `apps/platform-admin/src/tests/ccp-a8-support-extension-authorization.spec.ts`, **33 / 33** (real JwtAuthGuard + RolesGuard, service mocked). Real-Postgres route spec `ccp-a8-support-extension-routes.integration.spec.ts`, **4 / 4**.

| Route | platform_owner | finance_admin | commercial_ops | catalog_manager | support_admin | read_only_auditor | super_admin |
|---|---|---|---|---|---|---|---|
| `POST /support-extensions` | 403 | 403 | 403 | 403 | **201** (APPLIED / ESCALATED), 200 replay | 403 | 403 |
| `GET /support-extensions?tenant_id=` | **200** | **200** | **200** | 403 | **200** | **200** | 403 |
| `POST /change-requests/{id}/apply` (escalated extension or removal) | 403 `requester_scope_missing` | 403 | 403 | 403 | **200** | 403 | 403 (gate) |

The 403s on the two A8 routes carry `missing_scopes` = the route scope, and the service is never reached. Tenant-tier token → 403; no token → 401; 8 malformed bodies and 2 malformed queries → 400; 6 service errors mapped (A8-RT-MAP).

## 5. Pact, OpenAPI and gates

| Run | Result |
|---|---|
| Consumer `platform-web-consumer` | **46 interactions** (A6: 37; +9: POST in-bound 201 APPLIED, POST out-of-bound 201 ESCALATED, POST finance_admin 403, GET read_only_auditor 200, GET catalog_manager 403, plus super_admin 403 and tenant-tier 403 for each of the 2 routes) |
| Provider `verify-platform-admin` (`ARAMO_RUN_PACT_PROVIDER=1`) | **2 / 2 provider tests passed**: the CCP route coverage gate over **11 CCP routes** (A6: 9; +2) and the verification of all 46 interactions. New states: `a tenant with a past-due Stripe-owned Sign subscription exists` (params `tenant_id`, `subscription_id`), `a support extension has been applied` (seeded through the service's own HTTP surface as support_admin) |
| Consumer-contract count vs provider-verified count (A10 rule, reported separately) | platform-web → platform-admin: 46 consumer interactions; 46 verified by `verify-platform-admin`. Sign: 29 consumer interactions (11 / 6 / 12); 29 verified by `verify-sign` (1 provider test passed; it globs every subscription migration, A8 included) |
| `contract-parity:check` | 680 live routes (678 governed), 511 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified (A6: 678 / 676 / 509; +2 / +2 / +2) |
| `openapi:drift-check` | ok (9 files) |
| `redocly lint openapi/platform.yaml` | valid; 2 warnings, equal to the baseline count |
| `orphan-scopes:check` (+ `SELF_TEST=1`) | ok; self-test ok. `platform:subscription:support` and `platform:subscription:read` are now literally enforced; both classification entries removed (2 read reservations remain) |
| `env:passthrough-check` | ok (107 + 3 + 2; no new env var) |
| `error-codes:check`, `dead-error-codes:check` | ok, ok (no new error code) |
| `tests:integration:check`, `pg-test-image:check`, `api-spec-location:check` | pass (49 roots), ok, ok |
| `bash scripts/verify-vocabulary.sh` | OK: Tier 1, Tier 2, front-door clean. No exemption touched |
| `repo-map:generate` / `repo-map:check` | regenerated (3 files modified); ok |

The orphan-scope, contract-parity and repo-map gates read `git ls-files` / `git grep`. They ran under a temporary `GIT_INDEX_FILE` with intent-to-add entries for the 12 new paths; the real index is untouched (TD-A8-18).

## 6. Tests run and not run

**Docker outage.** The Docker daemon was hung from about 08:50 (HTTP 500 on every call) and was restarted by the lead (12 GB). Every integration and Pact result below comes from runs **after** the restart. My only outage-time integration attempt (the A8 lib spec: "Could not find a working container runtime strategy", 18 skipped) is superseded.

| Suite | Result |
|---|---|
| `libs/subscription` unit + `ARAMO_RUN_INTEGRATION=1`, `--maxWorkers=2` (full lib) | run 1: 20 / 23 files, 446 passed / 1 failed / 29 skipped: the 3 specs that apply a hand-kept chain prefix hit `subscription.SupportExtension does not exist` (TD-A8-15). After the shared helper: **23 / 23 files, 476 / 476 tests** |
| A8 lib integration spec | **18 / 18** |
| A8 + touched unit specs (verbose) | 3 files, **133 / 133** (A8 unit 34; A9-U-4; A6-SM-1) |
| The 3 rippled lib specs, after the helper | 3 files, **58 / 58** (the A4 equality and A5 goldens unchanged) |
| `apps/platform-admin` unit + integration (full) | **23 / 23 files, 488 / 488 tests** |
| platform-admin CCP route specs (A8 routes, A8 gate, A3 routes, A6 apply) | 4 files, **46 / 46** |
| `apps/api` targeted | run 1: `ccp-a4-ats-sign-availability` failed (same missing table); `s2-erasure-integrity`, `tenant-reset` passed (26 passed, 3 skipped). After the helper: `ccp-a4-ats-sign-availability` **3 / 3** (ATS RTR/Offer golden unchanged) |
| `apps/sign-service` `ccp-a4-ats-sign-consumption` (ATS-triggered Sign consumption golden) | **3 / 3** |
| Pact | §5 |
| lint `nx run-many -t lint -p subscription platform-admin` | 0 errors (59 / 89 warnings, pre-existing). ESLint on every changed or new `.ts`: 0 errors; the warnings are pre-existing non-null assertions in files A8 only edits |
| build `nx run-many -t build -p subscription platform-admin api sign-service --skip-nx-cache` | 4 projects + 75 dependency tasks succeeded; `dist/libs/subscription/src/index.d.ts` exports `SupportExtensionService` (HEAD marker checked) |
| Prisma | `prisma validate` + `prisma generate` (subscription) ok |
| **Not run** | the full `nx run api` (instructed); `pact:provider` for `verify.ts` / `verify-api.ts` / `verify-ti.ts` (they verify no surface A8 changes); full `apps/sign-service` and `apps/api` suites (only the allowance-reader goldens and the migration-globbing api specs were targeted) |

**Regression obligations.** Sign allowance semantics and ATS-triggered Sign consumption: the A4 equality, A5, ATS availability and ATS consumption goldens all match, with A8 applied. Tenant role catalog and super_admin bundle: unchanged (no identity change; super_admin refused on both routes). Stripe self-service: the lifecycle spec passes with A8 applied; no webhook or checkout code changed.

## 7. Recovery and rollback

- **Overlay recovery** (the A8 row): a `SUPPORT_EXTENSION` change request with `operation: REMOVE`, approved by Finance and applied, records the one removal, and the row stops sending (A8-REMOVE-1). Rows are never deleted.
- **Code:** revert A8-1…A8-7.
- **`verify-api.ts`:** not changed. No migration changes an apps/api returned shape. The allowance reader returns identical results without an overlay row (the api golden is unchanged).
- **Compensating SQL** (documented, not shipped; never run against production, PBD §7.5), in one transaction:

  ```sql
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM subscription."SupportExtension")
       OR EXISTS (SELECT 1 FROM subscription."CommercialChangeApplication" WHERE action_type = 'SUPPORT_EXTENSION')
       OR EXISTS (SELECT 1 FROM subscription."CommercialChangeRequest"
                   WHERE action_type = 'SUPPORT_EXTENSION' AND (kind = 'EXCEPTION' OR state IN ('APPLYING', 'APPLIED', 'APPLY_FAILED'))) THEN
      RAISE EXCEPTION 'CCP-A8 compensation refused: A8 state exists';
    END IF;
  END $$;
  DROP TRIGGER "commercial_change_request_exception_commits_applied" ON subscription."CommercialChangeRequest";
  DROP FUNCTION subscription."guard_commercial_exception_commits_applied"();
  DROP TRIGGER "commercial_change_request_no_applying_commit_a8" ON subscription."CommercialChangeRequest";
  DROP TABLE subscription."SupportExtension";
  DROP FUNCTION subscription."guard_support_extension"();
  ALTER TABLE subscription."CommercialChangeApplication" DROP CONSTRAINT "CommercialChangeApplication_action_type_check",
    ADD CONSTRAINT "CommercialChangeApplication_action_type_check" CHECK (action_type IN ('SUBSCRIPTION_OPEN','SUBSCRIPTION_CHANGE','SUBSCRIPTION_END','ENTITLEMENT_GRANT'));
  -- then re-run the CREATE OR REPLACE FUNCTION subscription."guard_commercial_change_request"() block of
  -- 20261025200000_ccp_a6_transactional_apply/migration.sql verbatim (the A6 body).
  ```

  Pending escalated or removal requests (NORMAL, not yet applying) can be withdrawn or rejected under A3 before the compensation runs.

## 8. Typed divergences

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| **TD-A8-1** | Interpretation | **What the extension extends**: the sending window of a PAST_DUE row (the Recon G1 reading: "never `grace_until`"). Wired into `AllowanceService.activePlan` only. The two lifecycle `subscriptionSends` call sites (`activated_by` and the C-4 / C-7 reactivation hold) are unchanged, so an overlay never changes webhook semantics. The tenant account view shows `sending: true` while `status` stays `PAST_DUE` | **Needs PO / Architect confirmation** |
| TD-A8-2 | Choice | `base_until = max(applied_at, grace_until)`: an extension adds days after the grace end, or after now if grace has ended | Recorded; CHECKed |
| **TD-A8-3** | Interpretation | **"Eligibility breach"** is not enumerated by any instrument. A8 escalates on `SUBSCRIPTION_NOT_PAST_DUE` and `REQUESTER_NOT_ATTESTED` (a zero-approval act needs a D9-attested actor). Missing scope, an unknown tenant, a row that is not open, and Q14 are **refusals**, not escalations | **Needs PO / Architect confirmation** |
| **TD-A8-4** | Fail-closed choice | Frequency and cumulative count **every** applied overlay of tenant × product: bounded or approved, removed or not. The A2 docstring says "in-limit extensions" | **Needs PO confirmation** |
| **TD-A8-5** | Authority / chain | **Removal**: payload `operation: REMOVE` on `SUPPORT_EXTENSION` (no new action type; the closed action CHECK is unchanged). Chain Finance-only (by analogy with TD-A3-2); requester and applier support_admin (TD-A6-3) | **Needs a ruling** on the removal chain and requester |
| **TD-A8-6** | Brief vs instruments | The brief says to refuse any SELF_SERVICE / Stripe-owned row. The Recon Report G1 puts the overlay **on** those rows. A8 applies the overlay to them and **refuses every write**: no A8 path issues a `TenantSubscription` UPDATE, proven by the tripwire (A8-G1-1). Refusing the overlay itself would make the extension inert for the only rows that go PAST_DUE | **Lead to confirm the reading.** No HALT: no mutation path exists |
| TD-A8-7 | Ordering | Escalation is A3 `create` and then `submit` (two transactions, reusing A3), plus a separate `SUPPORT_EXTENSION_ESCALATED` audit transaction. If `submit` fails, a DRAFT remains, and the requester can withdraw it | Recorded |
| TD-A8-8 | Scope | The generic `POST /change-requests` still admits a NORMAL `SUPPORT_EXTENSION` (EXTEND) from support_admin, which goes straight to Finance. This is strictly more control than the bounded path | Recorded |
| TD-A8-9 | Shape | New chain rule `BOUNDED_EXCEPTION` with zero steps. `parseRequiredChain` admits zero steps for that rule only; the OpenAPI enum is widened (platform-admin; covered by Pact, not `verify-api`) | Recorded |
| TD-A8-10 | TS mirror | `canTransitionFor` gains an optional `kind` (default NORMAL); `COMMERCIAL_TRANSITIONS` gains `DRAFT → APPLYING`; A6-SM-1 goes from 10 to 11; A9-U-4 is re-based | Recorded |
| **TD-A8-11** | Merge | The guard is re-created in `20261026010000` (A6 body verbatim + one A8 branch + one `DECLARE` variable). It adds two deferred constraint triggers and leaves the A6 trigger untouched. Parallel slices may replace the same function: **the lead unions them**, and the last migration by name must carry every branch | **For the lead** |
| TD-A8-12 | DB rule | An EXCEPTION request sets `submitted_at` / `expires_at` (= + 72 h) on leaving DRAFT, because the A3 CHECKs pair them. Expiry is moot, since the request commits only as APPLIED | Recorded |
| TD-A8-13 | A6 code change | `completeInTx` extracted unchanged; SUPPORT_EXTENSION admitted; non-NORMAL kinds refused by `apply`; 2 new failure codes (`EXTENSION_NOT_FOUND`, `EXTENSION_ALREADY_REMOVED`; no HTTP code change); the application CHECK widened | All A6 specs pass |
| TD-A8-14 | A3 code change | `CommercialChangeRequestService.expireOpenFor` is made public, so the bounded path applies the same lazy expiry before its Q14 check | Recorded |
| **TD-A8-15** | Ripple | 4 gated specs apply a hand-kept prefix of the subscription chain and then run HEAD code (lifecycle, A4 equality, A5, the api ATS golden). The reader now needs `SupportExtension`. Fix: **one shared helper** `libs/subscription/src/tests/fixtures/ccp-a8.ts` (`applyRemainingSubscriptionMigrations`), the same uniform edit in each, with goldens unchanged. The api spec imports it by relative path with an `enforce-module-boundaries` disable (TD-A3-19 precedent). The reader is **not** made fail-soft on a missing table | Recorded |
| TD-A8-16 | Merge | The orphan-scope entries for `platform:subscription:read` and `:support` are removed. Another slice may also remove `:read` | For the lead |
| TD-A8-17 | Choice | The GET list route is gated on `platform:subscription:read`, capped at 200 rows, not paged | Recorded (B6 may page it) |
| TD-A8-18 | Gates | Repo-map, orphan-scope and contract-parity ran under a temporary `GIT_INDEX_FILE` (as TD-A2-7) | Re-run `npm run repo-map:generate` if the staged set differs |
| TD-A8-19 | Environment | The Docker outage (§6): outage-time results are discarded | Recorded |
| TD-A8-20 | HTTP | Both new outcomes answer 201 (a request was created); a replay answers 200; `decision` is null on replay | Recorded |

## 9. Vocabulary result

`bash scripts/verify-vocabulary.sh`: OK. Tier 1, Tier 2 and front-door clean. No exemption allowlist was touched; the Stripe wire exemption (`stripe-wire.ts`) is unchanged and unused by A8.
