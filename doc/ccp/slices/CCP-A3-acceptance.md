# CCP-A3 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` §6.3 and the §5.1 A3 row.

| | |
|---|---|
| **Slice** | CCP-A3, change request, approval and eligibility |
| **Branch / baseline** | `feat/ccp-commercial-control-plane` at `b0e59aa6` (P-6 re-verification in `doc/ccp/slices/CCP-A3-pre-execution.md`) |
| **Local commit SHAs** | committed locally: `1346294f` CCP-A3 A3-0: P-6 path:line re-verification; `466aea18` CCP-A3 A3-5: four commercial error codes (committed first so later increments build); `6294481d` CCP-A3 A3-1: change request, approval and D9 attestation migration, Prisma models; `ca14de21` CCP-A3 A3-2: pure change-request model, chain resolution and checkApprovalEligibility; `abe809d0` CCP-A3 A3-3: live operator roster, attestation store and the transactional change-request service; `249b100a` CCP-A3 A3-4: unit and real-Postgres tests (refusal table, NC-1…NC-5, triggers, expiry, idempotency); `5bc3c19a` CCP-A3 A3-6: change-request and approval routes, OpenAPI and gates; `4b7bb83b` CCP-A3 A3-7: per-role allowed/refused tests for every change-request route |
| **HALT conditions hit** | None. "NC-5 rule unconfirmed" is discharged: the Lead Architect **RATIFIED** the rule on 2026-10-25 (TD-A3-0, `doc/ccp/decisions.md`). R-SOD (Commercial-Approval Directive `:89-92`) is not reinterpreted: requester ≠ approver is the application-layer `SELF_APPROVAL` refusal, and the DB has no CHECK or trigger for it (test A3-SELF-1 inserts a raw requester approval row and the DB admits it). Eligibility is never taken from a snapshot: roles, scopes and attestation are read live inside the approve transaction (A3-NC4-1). `COMMERCIAL_APPROVAL_POLICY_STORE` and the ADR-0024 store are not used. No new nx edge. |

## 1. Changes per increment (proposed commit map)

| # | Proposed commit | Files |
|---|---|---|
| A3-0 | `CCP-A3: P-6 path:line re-verification` | `doc/ccp/slices/CCP-A3-pre-execution.md` |
| A3-1 | `CCP-A3: change request, approval and D9 attestation migration, Prisma models` | `libs/subscription/prisma/migrations/20261025120000_ccp_a3_change_request_approval/migration.sql` (new); `libs/subscription/prisma/schema.prisma` |
| A3-2 | `CCP-A3: pure change-request model, chain resolution and checkApprovalEligibility` | `libs/subscription/src/lib/commercial/commercial-change-request.ts`, `commercial-approval-eligibility.ts` (new) |
| A3-3 | `CCP-A3: live operator roster, attestation store and the transactional change-request service` | `libs/subscription/src/lib/commercial/commercial-operator.repository.ts`, `commercial-change-request.service.ts` (new); `commercial-policy.repository.ts` (`getVersionPolicy`); `libs/subscription/src/lib/subscription.module.ts`; `libs/subscription/src/index.ts` |
| A3-4 | `CCP-A3: unit and real-Postgres tests (refusal table, NC-1…NC-5, triggers, expiry, idempotency)` | `libs/subscription/src/tests/commercial-approval-eligibility.spec.ts`, `commercial-change-request.integration.spec.ts`, `support/ccp-a3-database.ts` (new) |
| A3-5 | `CCP-A3: four commercial error codes` | `libs/common/src/lib/errors/error-codes.ts`, `aramo-error.ts`; `libs/common/src/tests/error-codes.spec.ts`; `openapi/common.yaml` |
| A3-6 | `CCP-A3: change-request and approval routes (platform:approval:read), OpenAPI and gates` | `apps/platform-admin/src/app/platform/platform-commercial-change-request.controller.ts`, `dto/commercial-change-request.dto.ts` (new); `apps/platform-admin/src/app/platform/platform.module.ts`; `openapi/platform.yaml`; `ci/config/api-surface-manifest.json`; `ci/scripts/verify-orphan-scopes.ts` |
| A3-7 | `CCP-A3: per-role allowed/refused tests for every change-request route` | `apps/platform-admin/src/tests/ccp-a3-commercial-change-request-authorization.spec.ts`, `ccp-a3-commercial-change-request-routes.integration.spec.ts` (new) |
| A3-8 | `CCP-A3: acceptance evidence` + `CCP-A3: regenerate repo map` | `doc/ccp/slices/CCP-A3-acceptance.md` (new); `doc/generated/repo-map.{files,coupling,projects}.json` |

**Unchanged:** `doc/ccp/decisions.md` (the lead's), every existing migration, `libs/identity` (no seed, catalog or migration change), `pact/`, `apps/api` sources, `apps/platform-web`, `subscription-lifecycle.service.ts`. No domain row (subscription, entitlement, plan, policy) is written by any A3 path.

## 2. Model

**`subscription."CommercialChangeRequest"`.** Closed `action_type` (14 values, CHECK): `SUBSCRIPTION_OPEN`, `SUBSCRIPTION_CHANGE`, `SUBSCRIPTION_END` (A6), `ENTITLEMENT_GRANT` (A6), `ENTITLEMENT_REVOKE` (A7), `PLAN_VERSION_PUBLISH`, `PLAN_RETIRE` (A5/B2), `POLICY_ACTIVATE` (Q1), `SUPPORT_EXTENSION` (A8, escalated), `ROLE_GRANT`, `ROLE_REVOKE` (A9), `CREDIT`, `DISCOUNT` (C4), `CONVERSION` (C2). The consuming slice of each is named in `COMMERCIAL_ACTION_TYPES` (`commercial-change-request.ts`). `kind` NORMAL / EXCEPTION / MIGRATION. Payload + SHA-256 checksum of its canonical JSON, the snapshotted `required_chain`, `policy_version_id` + `policy_checksum`, `requested_by`, `reason`, `idempotency_key` (UNIQUE), `tenant_id` + `product_key`: all immutable from INSERT (trigger). Q14: partial unique index on (`tenant_id`, `product_key`) over the open states DRAFT, PENDING_APPROVAL, APPROVED, APPLYING, APPLY_FAILED.

**`subscription."CommercialApproval"`.** Append-only (UPDATE and DELETE rejected). `UNIQUE(change_request_id, approver_user_id)`, `UNIQUE(change_request_id, step_index)` (D8). Carries the step's role and scopes, the approver's live role keys and the attestation id: the immutable evidence of who approved, when, under which authority.

**`subscription."CommercialOperatorAttestation"` (D9).** One active attestation per account and per attested human reference (SHA-256 hex, no PII) by partial unique indexes. Never deleted, revocable once. Method `BOOTSTRAP` (self, the D7 operator) or `PLATFORM_OWNER` (by a distinct attester, CHECK). An approver without an active attestation is `NOT_HUMAN`, and does not count toward chain satisfiability (fail closed).

**`CommercialAuditEvent.change_request_id`** gains the FK deferred by A2.

**Chains (D6 / Q1 / Q2 / Q7), snapshotted at creation from the ACTIVE policy:**

| Action | Chain |
|---|---|
| `CREDIT` ≥ `credit_escalation_threshold_minor` (or not in the policy currency), `DISCOUNT` ≥ `discount_escalation_threshold_bps` | finance_admin → platform_owner |
| `CREDIT`, `DISCOUNT` below threshold | finance_admin |
| `PLAN_VERSION_PUBLISH`, `PLAN_RETIRE` (catalog publish) | finance_admin → platform_owner (owner step also needs `platform:catalog:publish`) |
| `POLICY_ACTIVATE` (Q1) | finance_admin → platform_owner |
| `ROLE_GRANT`, `ROLE_REVOKE` (D6 owner/finance grants; Q2 others) | a distinct platform_owner |
| every other action (`SUBSCRIPTION_*`, `ENTITLEMENT_*`, `CONVERSION`, escalated `SUPPORT_EXTENSION` per Q7) | finance_admin |

## 3. Refusal table (`checkApprovalEligibility`, exactly 7 refusals)

Unit: `libs/subscription/src/tests/commercial-approval-eligibility.spec.ts`. Real Postgres: `commercial-change-request.integration.spec.ts` (A3-INT/NC/EXP IDs) and `apps/platform-admin/src/tests/ccp-a3-commercial-change-request-routes.integration.spec.ts` (A3-RI IDs). HTTP: 409 `COMMERCIAL_APPROVAL_REFUSED`, `details.refusal`.

| Refusal | Condition | Unit test IDs | Real-Postgres / HTTP test IDs |
|---|---|---|---|
| `NOT_PENDING` | state ≠ PENDING_APPROVAL (DRAFT, APPROVED, REJECTED, WITHDRAWN, EXPIRED) | A3-R-1a…1e, A3-R-PREC | A3-REJ-1, A3-NC1-2 |
| `EXPIRED` | now ≥ expires_at (half-open) | A3-R-2, A3-EXP-1, A3-EXP-3 | A3-EXP-INT-1, A3-EXP-INT-3 |
| `NOT_HUMAN` | actor_kind ≠ user, or no active D9 attestation | A3-R-3a, 3b, 3c | A3-NC2-3 |
| `SELF_APPROVAL` | actor is the requester, or the subject of a role change | A3-R-4a, 4b | A3-SELF-1, A3-REJ-1, A3-RI-APPROVE, A3-RI-REJECT |
| `USER_ALREADY_APPROVED` | actor approved another step of this request (NC-2) | A3-R-5, A3-R-OK-2 | A3-NC2-1, A3-RI-APPROVE-OWNER |
| `STEP_SCOPE_MISSING` | live roles/scopes do not satisfy the next step, nor any later step | A3-R-6a…6e | A3-NC4-1, A3-RI-APPROVE, A3-RI-REJECT |
| `OUT_OF_ORDER` | requested step ≠ next unfilled step, or qualifies only for a later step | A3-R-7a, 7b, 7c | A3-NC1-1, A3-RI-APPROVE-OWNER |

A3-R-0 pins the set and its order. Precedence is fixed (A3-R-PREC): NOT_PENDING, EXPIRED, NOT_HUMAN, SELF_APPROVAL, USER_ALREADY_APPROVED, then the step checks. Every refused attempt writes a `COMMERCIAL_APPROVAL_REFUSED` (or `COMMERCIAL_REJECTION_REFUSED`) audit row and nothing else (A3-SELF-1, A3-RI-APPROVE).

**Chain-satisfiability gate (A9 refinement).** Before eligibility, approve checks that the remaining steps can be filled by distinct attested humans other than the requester, the subject and prior approvers (bipartite matching, never a user count). If not: 409 `CCP_NOT_BOOTSTRAPPED`, `details.unfillable_steps`. Unit A3-SAT-1…6; real Postgres A3-NC2-2 (five platform users, still not bootstrapped for finance → owner; a finance-only chain proceeds), A3-NC2-3, A3-NC3-1; HTTP A3-RI-BOOT.

## 4. Negative controls NC-1…NC-5 (real Postgres 17)

| NC | Test ID | Output |
|---|---|---|
| **NC-1** concurrent approval | A3-NC1-1 | 5 finance approvers race on step 0 of a two-step chain: 1 `OK`, 4 `OUT_OF_ORDER`; 1 approval row; state PENDING_APPROVAL (no double-advance) |
| | A3-NC1-2 | 4 race on a one-step chain: 1 `OK`, 3 `NOT_PENDING`; 1 approval row; exactly 1 `COMMERCIAL_CHANGE_REQUEST_APPROVED` event |
| **NC-2** reused identities, D9 | A3-NC2-1 | the finance+owner user fills step 0, then step 1 → `USER_ALREADY_APPROVED`; a distinct owner completes |
| | A3-NC2-2 | with no other finance holder, that user alone → 409 `CCP_NOT_BOOTSTRAPPED`, `unfillable_steps: [1]` |
| | A3-NC2-3 | unattested finance holder → `NOT_HUMAN`; revoked attestation → `NOT_HUMAN`; attesting a second account for the same human → unique violation `CommercialOperatorAttestation_active_human_key`; with only unattested holders → `CCP_NOT_BOOTSTRAPPED` |
| **NC-3** stale chain | A3-NC3-1 (approve) | the only owner is revoked after step 0 → 409 `CCP_NOT_BOOTSTRAPPED`; state stays PENDING_APPROVAL |
| | A3-NC3-2 (apply) | approved request: apply check passes, then the finance signer is revoked → `APPROVER_NO_LONGER_ELIGIBLE`; an expired request → `NOT_APPROVED` |
| **NC-4** role revoked between request and approval | A3-NC4-1 | finance_admin removed after submit → `STEP_SCOPE_MISSING` (read live, in the transaction, with `FOR SHARE` on the RBAC rows); another finance holder approves |
| **NC-5** (ratified 2026-10-25) | **A3-NC5-a** | role revocation between approval and apply: the owner signer loses `platform_owner` → `assertApplyEligible` refuses `APPROVER_NO_LONGER_ELIGIBLE`; a revoked attestation is refused the same way |
| | **A3-NC5-b** | policy v2 is activated after the request was created (credit threshold $1,000.00, expiry 24 h): the request keeps `policy_version_id` v1 and the FINANCE_THEN_OWNER chain; `expires_at − submitted_at` = 72 h (v1, not v2's 24 h); one finance approval leaves it PENDING (v2 would have needed only finance); the apply check passes only after the owner signs; a request created after v2 resolves FINANCE_ONLY under v2 |
| | **A3-NC5-c** | after the apply refusal, `row_to_json` of both `CommercialApproval` rows and of the request row is byte-identical to before, and the audit row count is unchanged: the signatures are preserved and nothing is written |

Unit coverage of the apply-time check: A3-APPLY-U1…U8. The check takes **no policy argument** (A3-APPLY-U8 asserts its arity is 2: request and live roster), so it cannot consult a newer version.

**NC-5 rule as implemented (TD-A3-0, RATIFIED, Lead Architect 2026-10-25):**
1. *At approval:* identity (user principal + D9 attestation), authorization (live role and scopes for the step), separation of duties (requester, subject, prior approvers), approval sequence (the next step, explicit `step_index`) and request validity (state, expiry, payload checksum) are verified in one transaction. The approval is recorded as an append-only `CommercialApproval` row.
2. *At apply:* `assertChainStillSatisfiableAtApply(request, liveRoster)` (pure) and `CommercialChangeRequestService.assertApplyEligible(id, platform_tenant_id, tx?)` (read-only; A6 calls it inside its apply transaction) re-check every recorded approval against the request's snapshotted chain and the live roster. Lost eligibility throws `CommercialApplyRefusedError`; nothing is written and no approval row is touched.

## 5. State-machine transition table

DB guard trigger + `COMMERCIAL_A3_TRANSITIONS`; A3-SM-1 (unit) checks all 81 pairs: exactly 6 allowed.

| From \ To | PENDING_APPROVAL | APPROVED | REJECTED | EXPIRED | WITHDRAWN | APPLYING / APPLIED / APPLY_FAILED |
|---|---|---|---|---|---|---|
| DRAFT | ✅ submit (requester) | ❌ | ❌ | ❌ | ✅ withdraw (requester) | ❌ |
| PENDING_APPROVAL | — | ✅ last step approved (DB: needs one approval per step) | ✅ reject (eligible checker) | ✅ at/after `expires_at` (lazy, or `expireDue`) | ✅ withdraw (requester) | ❌ |
| APPROVED | ❌ | — | ❌ | ❌ | ❌ | ❌ until CCP-A6 replaces the guard function |
| APPLYING, APPLIED, APPLY_FAILED | defined, unreachable in A3 | | | | | |
| REJECTED, EXPIRED, WITHDRAWN, APPLIED | terminal: the row is frozen | | | | | |

DB proofs (A3-TRG-2): DRAFT → APPROVED refused; APPROVED with 0 of 2 and 1 of 2 approvals refused; APPROVED → APPLYING / APPLIED / APPLY_FAILED refused; a WITHDRAWN row is frozen; INSERT in any state but DRAFT refused; `expires_at` is immutable once set; no column changes without a transition.

## 6. Other mandatory tests

| Test | ID | Result |
|---|---|---|
| Self-approval refused | A3-SELF-1, A3-R-4a | `SELF_APPROVAL`; 0 approval rows; audited |
| 72 h expiry, exact / −1 ms / +1 ms | A3-EXP-1…3 (unit), A3-EXP-INT-1…3 (service, injected clock) | exactly 72 h → EXPIRED (request moves to EXPIRED, `COMMERCIAL_CHANGE_REQUEST_EXPIRED` + refusal audited); 72 h − 1 ms → recorded; 72 h + 1 ms → EXPIRED. `expires_at − submitted_at` = 72 h read back from Postgres |
| Immutability triggers | A3-TRG-1…4 | verbatim: `CommercialChangeRequest payload, chain and identity are immutable` (8 columns); `CommercialChangeRequest is append-only (DELETE rejected)`; `CommercialApproval is append-only evidence (UPDATE rejected)` / `(DELETE rejected)`; `CommercialApproval step 0 is out of order (next step 1, 2 steps)`; `CommercialApproval requires a PENDING_APPROVAL request (state REJECTED)`; `CommercialOperatorAttestation is append-only (DELETE rejected)`; `CommercialOperatorAttestation allows only a single revocation (UPDATE rejected)` |
| Integrity | A3-INTEG-1 | a payload changed with the trigger disabled → approve refused (409 `COMMERCIAL_CHANGE_REQUEST_CONFLICT`, reason `integrity`) |
| Idempotency-key replay | A3-IDEM-1, A3-IDEM-2 | replay (keys reordered) → same id, `replayed: true` (HTTP 200), 1 row, 1 CREATED event; different body → `IDEMPOTENCY_KEY_CONFLICT`; 4 concurrent creates with one key → 1 row, 1 non-replay |
| Q14 one open per tenant × product | A3-Q14-1…3, A3-RI-CREATE | second open → 409 `open_request_exists`; another tenant allowed; withdrawal or expiry frees the slot; 4 concurrent creates → 1 OK, 3 refused; a raw INSERT hits `CommercialChangeRequest_one_open_per_tenant_product_key` |
| Every request and approval audited | A3-INT-1, A3-RI-APPROVE | event sequence CREATED, SUBMITTED, APPROVAL_RECORDED ×2, APPROVED; actor role keys snapshotted (`[finance_admin]`, `[platform_owner]`) |
| Nothing applies | A3-INT-1 | 0 `TenantSubscription` rows, `applied_at` null |

## 7. Per-role matrix (every route; 6 roles + super_admin)

Route gate (`ccp-a3-commercial-change-request-authorization.spec.ts`, real JwtAuthGuard + RolesGuard, service mocked): for each of the 7 routes, all 6 CCP roles are admitted and **super_admin is refused with 403 `INSUFFICIENT_PERMISSIONS`, `missing_scopes` = [`platform:approval:read`]**, service never reached; a recruiter-tier token → 403; no token → 401.

Outcome below the gate (`ccp-a3-commercial-change-request-routes.integration.spec.ts`, real guards + real service + real Postgres):

| Route | platform_owner | finance_admin | commercial_ops | catalog_manager | support_admin | read_only_auditor | super_admin |
|---|---|---|---|---|---|---|---|
| `POST /change-requests` (SUBSCRIPTION_OPEN) | 403 `requester_scope_missing` | 403 | **201** | 403 | 403 | 403 | 403 (gate) |
| `POST` (PLAN_VERSION_PUBLISH) | 403 | 403 | 403 | **201** | 403 | 403 | 403 (gate) |
| `POST` (SUPPORT_EXTENSION) | 403 | 403 | 403 | 403 | **201** | 403 | 403 (gate) |
| `POST` (POLICY_ACTIVATE) | 403 `requester_authority_undefined` | 403 | 403 | 403 | 403 | 403 | 403 (gate) |
| `GET /change-requests`, `GET /:id` | **200** | **200** | **200** | **200** | **200** | **200** | 403 |
| `POST /:id/submit`, `/:id/withdraw` (request by commercial_ops) | 403 `not_requester` | 403 | **200** (requester) | 403 | 403 | 403 | 403 |
| `POST /:id/approvals` step 0, finance-only chain | 409 STEP_SCOPE_MISSING | **201** | 409 SELF_APPROVAL | 409 STEP_SCOPE_MISSING | 409 STEP_SCOPE_MISSING | 409 STEP_SCOPE_MISSING | 403 |
| `POST /:id/approvals` step 1, finance → owner | **201** | 409 USER_ALREADY_APPROVED | 409 SELF_APPROVAL | 409 STEP_SCOPE_MISSING | 409 STEP_SCOPE_MISSING | 409 STEP_SCOPE_MISSING | 403 |
| `POST /:id/reject` | 409 STEP_SCOPE_MISSING | **200** | 409 SELF_APPROVAL | 409 STEP_SCOPE_MISSING | 409 STEP_SCOPE_MISSING | 409 STEP_SCOPE_MISSING | 403 |

Also: per-step caller verdicts on `GET /:id` per role (A3-RI-READ); `eligible_for_me` (A3-RI-READ); 12 malformed requests → 400 without reaching the service; 13 service errors mapped to their HTTP codes (A3-RT-MAP).

## 8. Tests and gates run and not run

Docker was available. All counts are exact.

**Run:**

| Run | Command | Result |
|---|---|---|
| A3 unit | `vitest run --root libs/subscription src/tests/commercial-approval-eligibility.spec.ts` | 71 / 71 |
| A3 integration | `ARAMO_RUN_INTEGRATION=1 … commercial-change-request.integration.spec.ts` | 31 / 31 |
| subscription full (unit + integration) | `ARAMO_RUN_INTEGRATION=1 vitest run --root libs/subscription --maxWorkers=2` | see the note below the table |
| platform-admin full (unit + integration) | `ARAMO_RUN_INTEGRATION=1 vitest run --root apps/platform-admin --maxWorkers=2` | **18 / 18 files, 418 / 418 tests** (A3: 84 gate + 7 route-integration; the AppModule-booting specs construct the widened SubscriptionModule) |
| common | `vitest run --root libs/common` | 12 files passed, 1 skipped; 83 passed, 2 skipped (error-code parity included) |
| lint | `nx run-many -t lint -p subscription platform-admin common --skip-nx-cache` | 0 errors (39 / 89 / 3 warnings, all pre-existing; the new files have none) |
| build, CI-simulated | `nx run-many -t build -p subscription platform-admin common api sign-service --skip-nx-cache` | 5 projects + 74 dependency tasks succeeded; `dist/libs/subscription/src/index.d.ts` exports `CommercialChangeRequestService` (HEAD marker checked) |
| typecheck | `nx run-many -t typecheck -p subscription platform-admin common --skip-nx-cache` | 3 / 3 |
| Prisma | `prisma validate` + `prisma generate` (subscription) | valid; generated |
| `orphan-scopes:check` (+ `SELF_TEST=1`) | temporary index (TD-A3-20) | ok; self-test ok |
| `contract-parity:check` | temporary index | 677 live routes (675 governed), 508 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified (A2: 670 / 668 / 501; +7 / +7 / +7) |
| `openapi:drift-check` | | ok (9 files) |
| `redocly lint openapi/platform.yaml` | | valid; the 2 pre-existing warnings only (`no-server-example.com`, `no-ambiguous-paths`) |
| `error-codes:check`, `dead-error-codes:check` | | ok, ok |
| `tests:integration:check`, `pg-test-image:check`, `env:passthrough-check`, `api-spec-location:check` | | pass (49 roots; all callers use `ARAMO_POSTGRES_TEST_IMAGE`; 107 + 3 + 2 env, no new var) |
| `libs/identity/scripts/scope-catalog-consistency.mjs` | | PASS (CCP A1 matrix: 6 roles, 45 rows; super_admin commercial scopes 0) |
| `bash scripts/verify-vocabulary.sh` | | exit 0; Tier 1, Tier 2, front-door clean |
| `repo-map:generate` / `repo-map:check` | temporary index | generated (`doc/generated/repo-map.{files,coupling,projects}.json` modified); `repo-map:check ok`, self-test ok |
| subscription unit only | `vitest run --root libs/subscription` | 7 files passed, 7 skipped (integration-gated); 174 passed, 120 skipped |
| platform-admin unit only | `vitest run --root apps/platform-admin` | 10 / 10 files, 300 / 300 tests |

**The full subscription suite (unit + integration) did not complete green on this host.** The host was overloaded: load average 20 to 43, with the Docker VM process at 98% CPU and other sessions active. The failures are timeouts and container-start failures, not assertion failures:

| Run | Result | Cause |
|---|---|---|
| 1 (concurrent with the platform-admin suite) | 13 / 14 files, 293 / 294 tests | A3-NC5-b exceeded vitest's 5 s default (the test took 31.7 s). Fixed by the 120 s describe timeout (TD-A3-22) |
| 2 (after the fix) | not readable: the captured output was truncated | A3-NC2-2 failed after 10.8 s; the next 10 A3 tests failed in 0 to 59 ms, which matches a failing `beforeEach` (schema re-apply) under load. The error text was not captured |
| 3 | 11 / 14 files, 242 passed, 52 skipped; **the A3 spec passed** | 3 pre-existing specs (`commercial-catalog-a1`, `personal-free`, `subscription-lifecycle`) failed at container start: `Health check not healthy after 120000ms` |
| 3 rerun of those 3 files, `--maxWorkers=1` | 2 / 3 files, 51 / 52 | `personal-free`: one test timed out at 5.93 s (5 s default) |
| `personal-free` alone | 8 / 9 | a different test timed out at 5.16 s; load average 42.93. The spec applies no A3 migration and calls no A3 code |
| A3 integration spec alone (2 runs) | **31 / 31** each time | |

**For the lead:** rerun `ARAMO_RUN_INTEGRATION=1 vitest run --root libs/subscription --maxWorkers=2` on an idle host before the push to get one complete green run.

**Not run:**
- The full `ARAMO_RUN_INTEGRATION=1 nx run api` suite (CI runs it; ruling A0-C16 and the brief). A3 changes no apps/api source; the api build succeeded. apps/api specs that glob every subscription migration will apply the A3 migration in CI; it references no other schema.
- Pact (`verify-sign`, `verify-api`). `verify-sign` applies subscription migrations by glob and picks A3 up; A3 changes no returned shape of an existing route, so nothing is registered in `verify-api.ts`. The 7 new routes have no consumer contract until CCP-A10 (TD-A3-17).

**Sufficiency.** Every A3 surface ran against real Postgres (triggers, unique indexes, row locks, live RBAC read, concurrency) and through the real guard chain (per-role matrix). Residual risks: the CI-only full api suite and the deferred A10 contracts.

## 9. Recovery and rollback

- **Requests expire;** no domain data mutates in A3, so there is nothing to reverse. A wrong request is withdrawn (requester) or rejected (checker).
- **Code:** revert the A3 commits. Nothing outside A3 calls the new service.
- **Compensating migration (documented, not shipped).** In one transaction: `RAISE` if any `CommercialChangeRequest` row exists; `ALTER TABLE subscription."CommercialAuditEvent" DROP CONSTRAINT "CommercialAuditEvent_change_request_id_fkey"`; drop index `CommercialAuditEvent_change_request_id_created_at_id_idx`; drop tables `CommercialApproval`, `CommercialChangeRequest`, `CommercialOperatorAttestation`; drop functions `guard_commercial_change_request`, `guard_commercial_approval_insert`, `reject_commercial_approval_mutation`, `guard_commercial_operator_attestation`. Never executed against production under this directive (PBD §7.5).

## 10. Typed divergences

| ID | Divergence | Disposition |
|---|---|---|
| **TD-A3-0** | NC-5: the PO ruled the rule (2026-10-24); the schedule names the Architect as confirmer. | **RATIFIED (Lead Architect 2026-10-25)**, `doc/ccp/decisions.md`. Implemented as ratified (§4): approval-time verification and immutable evidence; apply-time re-check of **each approval** under the snapshotted chain, never a newer policy; fail-closed refusal with no mutation and no change to the signature. Mandatory tests A3-NC5-a, -b, -c pass. |
| TD-A3-1 | Q14 product part: `product_key` column now, **no DB default**, set explicitly by the service, with an interim closed CHECK (`sign`) and the one-open index on (`tenant_id`, `product_key`). | Executor choice (brief option 1 without the default, per PBD §7.1). CCP-A4 replaces the CHECK with the governed registry. |
| TD-A3-2 | The chain **shapes** are the D6 / Q1 / Q2 / Q7 rulings, held in code (`resolveRequiredChain`); the **thresholds** come from the policy. The format-1 policy document has a closed key set with no chain keys. Actions with no threshold dimension (subscription, entitlement, conversion, escalated extension) take the finance-only chain (D6 "below threshold"; DDR v1.2 §3.1: finance_admin "approves … subscription terms"). `PLAN_RETIRE` takes the catalog-publish chain. | Needs PO/Architect confirmation of the no-threshold actions and `PLAN_RETIRE`. Changing one is a one-line table change plus A3-CH rows. |
| TD-A3-3 | D9: the attestation is a `CommercialOperatorAttestation` row (one active per account and per human reference). A3 ships the store, the fail-closed read and repository methods, but **no HTTP write path**: until CCP-A9's bootstrap and role-grant paths write attestations, every approval is refused (fail closed). The human reference is supplied by the attesting operator; its correctness is procedural. A missing attestation reports `NOT_HUMAN`. | Recorded for A9 and for PO confirmation of the attestation statement (`D9-v1`). |
| TD-A3-4 | Live eligibility is one raw cross-schema read of the identity RBAC tables inside the subscription transaction (`FOR SHARE OF m, mr`), mirroring the platform token's membership filter, plus an active User; only `platform:*` scopes count. No `@aramo/identity` import, so no nx edge. | Precedent: raw cross-schema reads in a caller's transaction (Recon Report §1 C3). |
| TD-A3-5 | No instrument names a **requester** for `POLICY_ACTIVATE`, `ROLE_GRANT` or `ROLE_REVOKE`. Creating them is refused (403 `requester_authority_undefined`) for every role; their chains and the approval engine are implemented and tested. | Needs a ruling: who requests a policy activation (A3/B5); A9 defines the role-change requester. |
| TD-A3-6 | A step is a role **and** scopes. The finance step requires `finance_admin` (a platform_owner cannot fill it); the owner step requires `platform_owner`. The A1 catalog has no governance-approve scope, so governance steps (policy, role) require the role plus all four `*:approve` scopes. `STEP_SCOPE_MISSING` also covers a missing role. | Executor reading of D6 ("finance, then owner") and DDR v1.2 §3.1; fail-closed. |
| TD-A3-7 | Route gate `platform:approval:read` (held by the 6 CCP roles, not super_admin) on all 7 routes, write routes included; the authority is enforced in the service. 10 commercial scopes move from `ACTIVE_RESERVED` to `SERVICE_ENFORCED` in `verify-orphan-scopes.ts` (requester: `subscription:request`, `entitlement:request`, `billing:request`, `catalog:draft`, `subscription:support`; step: `subscription:approve`, `entitlement:approve`, `billing:approve`, `catalog:approve`, `catalog:publish`); `approval:read` is now literally enforced; 3 read reservations remain. | `@RequireScopes` is all-of and cannot express "the action's scope"; per-action routes would multiply routes without adding authority. |
| TD-A3-8 | Approve requires an explicit `step_index`, so a stale client cannot advance the next step. An NC-1 loser gets `OUT_OF_ORDER` (two-step chain) or `NOT_PENDING` (one-step chain). | Within the 7 refusals. |
| TD-A3-9 | `CCP_NOT_BOOTSTRAPPED` gates **approve** only (reject is always safe and is not gated). The same 409 is the NC-3 "stale chain" refusal at approve time: one code for "this chain cannot be fulfilled". Refused attempts are audited. | Matches the A9 refinement wording ("approval routes"). |
| TD-A3-10 | Expiry is lazy (on approve, reject, withdraw, and a create for the same tenant × product), plus `expireDue()`, which is not scheduled (no worker in A3). An APPROVED request does not expire; the apply check refuses anything not APPROVED, which is how NC-3 "expired … refused at apply" is met. | No scheduler in A3 scope; a sweep worker can call `expireDue` later. |
| TD-A3-11 | DB backstops beyond the row: APPROVED needs one approval per step; an approval INSERT must be the next step and the request PENDING; APPLYING / APPLIED / APPLY_FAILED are unreachable until A6 replaces `guard_commercial_change_request()`. None of these is requester ≠ approver (D8). | Additive hardening ("no approval bypass through SQL", PBD §12). |
| TD-A3-12 | `SELF_APPROVAL` also refuses the **subject** of a role change approving their own grant or revoke. | Reading of D6 "a distinct platform_owner". |
| TD-A3-13 | 4 new error codes, so A3 touches `libs/common` and `openapi/common.yaml`: `CCP_NOT_BOOTSTRAPPED` (409, named by the brief), `COMMERCIAL_APPROVAL_REFUSED` (409), `COMMERCIAL_CHANGE_REQUEST_CONFLICT` (409), `COMMERCIAL_POLICY_UNAVAILABLE` (503). | Registry is append-only; parity and dead-code gates pass. |
| TD-A3-14 | Only `NORMAL` requests are created through the route. `EXCEPTION` belongs to the A8 bounded path and `MIGRATION` to A11. | Fail closed (400 `kind_not_supported`). |
| TD-A3-15 | Payload validation covers only what chain resolution and eligibility read (credit amount and currency, discount bps, extension days, role subject, policy version id); the applying slice owns each full schema. The payload is frozen at creation either way. | Schedule boundary. |
| TD-A3-16 | `assertChainStillSatisfiableAtApply(request, liveRoster)`: the request argument carries its approvals. Per the ratified rule it re-checks **each signer** (not just "some satisfiable set of humans", the PO's 2026-10-24 wording). | Conforms to the ratification. |
| TD-A3-17 | No Pact consumer contract for the 7 routes. | CCP-A10 (D11), as TD-A2-11. |
| TD-A3-18 | Submit computes `expires_at` from the request's **own** policy version (`getVersionPolicy`, which accepts a RETIRED version and re-verifies the checksum), not from the currently ACTIVE one. | NC-5. |
| TD-A3-19 | One shared real-Postgres test helper (`libs/subscription/src/tests/support/ccp-a3-database.ts`) is imported by the platform-admin spec through a relative path with an `enforce-module-boundaries` disable (precedent: `apps/talent-intelligence-service/src/tests/ingest.spec.ts:19-20`). It restates the A1 §4.1 bundles (as TD-A1-7 / TD-A2-10). | CLAUDE.md "one shared test helper". |
| TD-A3-20 | The repo-map, orphan-scope and contract-parity gates ran under a temporary `GIT_INDEX_FILE` with intent-to-add entries for the 13 new paths; the real index is untouched. | As TD-A2-7. Re-run `npm run repo-map:generate` if the staged set differs. |
| TD-A3-21 | `eligible_for_me=true` is a bounded scan (500 open PENDING requests), evaluated with the caller's live facts, and is not paged (`next_cursor` null). | The open set is small by construction (Q14, 72 h). |
| TD-A3-22 | Both A3 integration describes set a 120 s per-test timeout. Under concurrent Docker load (two suites at once) single tests took over 20 s and exceeded vitest's 5 s default; they pass at the default when run alone. | Test-only. |

## 11. Vocabulary result

`bash scripts/verify-vocabulary.sh`: exit 0; Tier 1, Tier 2 and front-door clean. No exemption added. The project write hook flagged one Tier-2 token in an identifier during authoring (`commercial-approval-eligibility.ts`); it was renamed before any gate run.
