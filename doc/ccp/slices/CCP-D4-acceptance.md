# CCP-D4 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.4 D4 row (`:124`): "**In:** program-level NC-1…NC-5, self-approval, one person holding several roles; tenant isolation; E2E and UAT scripts per role; re-run of the CCP-A1 per-role `platform:tenant:read` allowed/refused matrix | The full suites | Test-only | **HALT:** any negative control that passes when it should refuse | Suite outputs per role". NC-1…NC-5 as worded in the Charter §6.4 (`Aramo-CCP-Program-Charter-v1_0-LOCKED.md:207-211`), with the rulings in `doc/ccp/decisions.md` (TD-A3-0 NC-5, TD-A3-2, TD-A3-5, TD-A3-6, TD-A6-3 narrowed by TD-B2-3 requester-only apply, TD-A6-5 apply deadline / Charter Amendment A1, Q2, Q7, Q14, A9 last owner, D9 attestation).

| | |
|---|---|
| **Slice** | CCP-D4: RBAC negative-control + tenant-isolation suites, E2E and UAT |
| **Branch / baseline** | `wip/ccp-d4` at `41a0e3b5` (the integrated program) |
| **Local commit SHAs** | **none.** Nothing committed, pushed or stashed (Gate 5). |
| **HALT conditions hit** | **None.** No negative control passed when it should refuse. No production-code defect was found; no production file was changed. |
| **Recovery** | Test-only: delete the files in §1. |

## 1. Files (all new, except one config line)

| File | What |
|---|---|
| `apps/platform-admin/src/tests/support/ccp-d4-harness.ts` | ONE shared harness: boots the REAL platform-admin `AppModule` (as `main.ts`) on a Postgres testcontainer with the full program chain (`applyCcpA6Schema`); no resolver override (real JwtAuthGuard + identity RBAC resolver + RolesGuard + services); one attested operator per role plus a second per chain role; route enumeration from the AppModule controller metadata (as the A10 coverage gate). Two test seams only: a `@Global` `COMMERCIAL_CLOCK` (the services' `@Optional` clock token) for millisecond boundaries, and an in-memory `BILLING_PROVIDER_READ_PORT` that records every provider ref read (no Stripe). |
| `apps/platform-admin/src/tests/support/ccp-d4-scenarios.ts` | One scenario per commercial action type (all 14 of `COMMERCIAL_ACTION_TYPES`) plus the two escalated money actions, created ONLY through the HTTP surface; requester role, chain, apply route per type. |
| `apps/platform-admin/src/tests/ccp-d4-negative-controls.integration.spec.ts` | 15 tests: route gate, create matrix, self-approval, NC-1…NC-5, multi-role, D9, requester-only apply, APPLY_EXPIRED boundary, last owner, super_admin. |
| `apps/platform-admin/src/tests/ccp-d4-tenant-isolation.integration.spec.ts` | 3 tests: every tenant-scoped read, every tenant-scoped write, cross-product (MP-A2 N-12). |
| `apps/platform-admin/src/tests/ccp-d4-a1-role-matrix.integration.spec.ts` | 113 tests: re-run of the CCP-A1 §4.2.1 matrix on the real AppModule + real RBAC. |
| `apps/platform-web/e2e/journeys/ccp-d4-role-journeys.spec.ts` | 39 Playwright journeys, one `describe` per role. |
| `apps/platform-web/e2e/fixtures/ccp-d4-world.ts` | A stateful cross-persona fixture on top of the existing CCP mock harness (one set of requests / approvals / applies / audit that every persona reads). |
| `apps/platform-web/playwright.config.ts` | **Modified:** one project line `{ name: 'journeys', testMatch: /journeys\/.*\.spec\.ts$/ }`. |
| `doc/ccp/uat/CCP-UAT-{platform_owner,finance_admin,commercial_ops,catalog_manager,support_admin,read_only_auditor,super_admin}.md` | 7 manual UAT scripts (non-production only). |
| `doc/ccp/slices/CCP-D4-acceptance.md` | This record. |
| `doc/generated/repo-map.*.json` | Regenerated. |

No integration root was added (`apps/platform-admin` is already a root): `npm run tests:integration:check` → "integration-root coverage guard PASSED — 49 bearing project(s) all covered by 49 root(s) + 1 alias(es) + 0 exemption(s)".

## 2. Program-level suites (real Postgres 17, `ARAMO_RUN_INTEGRATION=1`, `--maxWorkers=2`)

Command (from `apps/platform-admin`): `ARAMO_RUN_INTEGRATION=1 npx vitest run --maxWorkers=2 --reporter=verbose --silent=false src/tests/<file>`.

| Suite | Result |
|---|---|
| `ccp-d4-negative-controls.integration.spec.ts` | **15 passed (15)** (final run; see O-D4-3 for one intermittent 14 / 15 run) |
| `ccp-d4-tenant-isolation.integration.spec.ts` | **3 passed (3)** |
| `ccp-d4-a1-role-matrix.integration.spec.ts` | **113 passed (113)** |
| `ccp-a1-platform-role-authorization.spec.ts` (the original A1 spec, re-run unchanged) | **119 passed (119)** |
| Playwright `--project=journeys` (`PW_E2E_PORT=4480`, `--workers=2`) | **39 passed (39)**, 0 failed, 0 fixme |

### 2.1 D4-GATE-1 — every `/platform/commercial` route (enumerated from the AppModule)

39 routes. For every route: no session → 401 (39 / 39); a tenant-tier token → 403 `tenant_token_on_platform_route` (39 / 39); super_admin → 403 naming the route scope (39 / 39); every CCP role is refused at the gate exactly when its A1 bundle lacks the route scope, and admitted otherwise (0 violations). Every route declares `@RequireScopes`.

| Role | Admitted by the gate | Refused at the gate (403 `missing_scopes`) |
|---|---|---|
| platform_owner | 36 | 3: `POST catalog/plans/:planId/drafts`, `PATCH catalog/versions/:versionId`, `POST support-extensions` |
| finance_admin | 36 | 3: the same three |
| commercial_ops | 34 | 5: the same three + `GET audit-events`, `POST audit-events/export` |
| catalog_manager | 20 | 19: every billing, subscription, contract, usage, finance, support-extension, tenant read, audit and billing-alert/metric route |
| support_admin | 35 | 4: `GET audit-events`, `POST audit-events/export`, the two catalog draft routes |
| read_only_auditor | 36 | 3: the two catalog draft routes + `POST support-extensions` |
| super_admin | **0** | **39** |

### 2.2 Per-action controls (14 action types)

| Test | Outcome |
|---|---|
| **D4-CREATE-1** create, per role | For every type only the requester creates (201): commercial_ops (subscription ×3, entitlement ×2, conversion, credit, discount), support_admin (support extension), catalog_manager (publish, retire), finance_admin (POLICY_ACTIVATE), platform_owner (ROLE_GRANT, ROLE_REVOKE). Every other CCP role: 403 `requester_scope_missing` / `requester_role_missing` (support extension: 403 at the gate, `platform:subscription:support`); super_admin 403 at the gate. Request rows written by a refused create: 0. 14 / 14 types. |
| **D4-SELF-1** self-approval | The requester is an operator holding the requester role AND every step role of the chain: 409 `SELF_APPROVAL` on all 14 types; 0 approval rows; state stays PENDING_APPROVAL. |
| **D4-NC1** concurrent approval | 4 distinct eligible humans race the same step: `201, 409, 409, 409` on all 21 steps (11 one-step types, 3 two-step types × 2 steps, escalated CREDIT and DISCOUNT × 2 steps). Losers: `NOT_PENDING` (last step) or `OUT_OF_ORDER` (step 0 of a two-step chain). One approval row per step; no double-advance. |
| **D4-NC1-APPLY** concurrent apply | 3 parallel applies by the requester: `200, 200 replayed, 200 replayed` on all 10 applyable types; exactly one `COMMERCIAL_CHANGE_REQUEST_APPLIED` event each. |
| **D4-NC2** one person, several roles | A finance_admin + platform_owner user and a user holding all 6 CCP roles each fill step 0 of every two-step chain (publish, retire, POLICY_ACTIVATE, escalated credit, escalated discount) and are refused step 1 `USER_ALREADY_APPROVED`: 10 / 10. A distinct owner then completes. |
| **D4-NC2-D9** attestation | An unattested holder of the step role and a holder whose attestation was revoked: 409 `NOT_HUMAN` on all 14 types (28 refusals), 0 approval rows. A second account for an already-attested human cannot be attested (unique `CommercialOperatorAttestation_active_human_key`). |
| **D4-NC3** stale chains at approve | (a) Approval TTL on all 14 types: at `expires_at − 1 ms` the approval is admitted (201); exactly at `expires_at` → 409 `EXPIRED` and the request becomes EXPIRED (half-open, TD-A2-1). (b) Every holder of the step role suspended: 409 `CCP_NOT_BOOTSTRAPPED` on all 14 types, state unchanged; step 1 of the 5 two-step chains with the only remaining owner being the step-0 signer: 409 `CCP_NOT_BOOTSTRAPPED`. 33 / 33. (At apply: §NC-5 and D4-TTL-1.) |
| **D4-NC4** role revoked between request and approval | All 21 steps: an approver who lost the step role but still passes the route gate → 409 `STEP_SCOPE_MISSING` (live eligibility in the transaction); an approver whose only role was revoked → 403 at the gate. 0 approval rows; a still-eligible human then fills the step. |
| **D4-NC5-ROLE** eligibility lost between approval and apply (TD-A3-0) | On all 10 applyable types the last signer loses the step role: the requester's apply → 409 `APPROVER_NO_LONGER_ELIGIBLE`, state stays APPROVED, 0 applied events, 0 application rows, approval rows byte-identical. After the role is restored the same request applies (200) and the signatures are still byte-identical. |
| **D4-NC5-POLICY** policy-version change (TD-A3-0) | A policy version activated through the governed HTTP flow (finance drafts +3000 bps discount threshold; finance requests; a distinct finance and an owner sign; the requester applies). An in-flight escalated DISCOUNT keeps `FINANCE_THEN_OWNER` and its snapshotted version, and needs the owner step; a new DISCOUNT of the same size is `FINANCE_ONLY` under the new version; an in-flight SUBSCRIPTION_OPEN approves and applies with its snapshotted `policy_version_id`. |
| **D4-APPLY-1** requester-only apply (TD-A6-3 / TD-B2-3) | On all 10 applyable types every other principal (each CCP role, a second holder of the requester role, every signer, super_admin) → 403 (`not_requester`; for `…/convert` non-requester roles get `requester_scope_missing`; super_admin at the gate); `apply_actionable` false for all of them and true for the requester only; the requester applies (200), a replay is `replayed: true`, exactly one applied event. CREDIT and DISCOUNT stay APPROVED and apply → 409 `action_not_applicable` (C4 not delivered); ROLE_GRANT and ROLE_REVOKE are APPLIED inside the final approval and apply → 409 `action_not_applicable`. |
| **D4-TTL-1** APPLY_EXPIRED at the boundary (Charter Amendment A1) | Under a policy version carrying `apply_expiry_hours = 72`: on all 10 applyable types, `deadline − 1 ms` → 200; exactly at the deadline → 409 (`apply_expired`; `…/convert` reports `APPLY_EXPIRED`), the request is APPLY_EXPIRED, 0 applied events, 0 application rows. |
| **D4-LAST-1** last-owner invariant | With one effective platform_owner: the governed ROLE_REVOKE → 409 `PLATFORM_LAST_OWNER`; the DB refuses role removal, membership deactivation and user deactivation (`platform_last_owner: the platform must keep at least one active platform_owner`). With two owners, revoking one needs the other as checker, who is its subject → 409 `CCP_NOT_BOOTSTRAPPED`; both owners remain. |
| **D4-SUPER-1** super_admin | Its live role scopes are the 10 non-commercial ones (0 commercial); a ROLE_GRANT of super_admin → 400 `invalid_payload`; it cannot sign (403). |

### 2.3 Tenant isolation (`ccp-d4-tenant-isolation.integration.spec.ts`)

Two fully populated tenants A and B (governed contract subscription applied through HTTP, entitlement, a self-service PAST_DUE row with an applied support extension, an open CREDIT, audit trail).

**D4-ISO-READ (13 reads).** Addressed to B, none returns any of A's ids, and the billing reader is never asked for A's provider ref: `GET tenants/{id}/commercial`, `GET tenants/{id}/billing-status`, `GET contracts?tenant_id`, `GET support-extensions?tenant_id`, `GET usage/periods?tenant_id`, `GET audit-events?tenant_id`, `POST audit-events/export {tenant_id}`, `GET billing-commands?tenant_id`, `GET finance/renewals?tenant_id`, `GET finance/outstanding-payments?tenant_id`, `GET finance/reconciliation-report?tenant_id`, `GET alerts/billing?tenant_id`, `GET alerts/approvals?tenant_id`. Positive control (the same read addressed to A returns A's ids) on 6 of the 13; the other 7 hold no row of A of that kind in this fixture (usage periods, billing commands, renewals, outstanding payments, the two alert lists), so for them the test is a no-leak check only.

**D4-ISO-WRITE (9 writes).** Each addressed to a fresh B-shaped tenant and naming one of A's rows; A's subscriptions, entitlements, contract, amendments and extensions are byte-identical afterwards.

| Write | Refusal |
|---|---|
| SUBSCRIPTION_CHANGE naming A's subscription | apply 409 `TARGET_NOT_FOUND` |
| SUBSCRIPTION_END naming A's subscription | apply 409 `TARGET_NOT_FOUND` |
| SUBSCRIPTION_OPEN replacing A's subscription | apply 409 `TARGET_STALE` |
| contract amendment of A's contract on B's row | apply 409 `CONTRACT_MISMATCH` |
| SUBSCRIPTION_END of B's row ending A's contract | apply 409 `CONTRACT_MISMATCH` |
| CONVERSION of A's governed subscription | convert 409 `TARGET_NOT_FOUND` |
| support extension of A's row via B | 400 `subscription_not_open` |
| support extension REMOVE of A's overlay via B | apply 409 `EXTENSION_NOT_FOUND` |
| ENTITLEMENT_REVOKE of B | applied (200) to B only; A unchanged |

**D4-ISO-PRODUCT (MP-A2 N-12, 6 checks).** A second product key registered in this test database only: a change request naming it → 400 `unknown_product_key`; a Sign END naming its row → apply 409 `TARGET_NOT_FOUND`; a support extension naming its row → 400 `subscription_not_open`; `GET subscriptions?product_key=sign`, `GET usage/reconciliation?product_key=sign`, `GET finance/reconciliation-report?…&product_key=sign` never return it; the row is byte-identical afterwards.

### 2.4 Re-run of the CCP-A1 per-role `platform:tenant:read` matrix

`ccp-d4-a1-role-matrix.integration.spec.ts`, 113 / 113, on the real AppModule with no resolver or service stub:

| Role | Allowed R-1…R-6 (200) | Refused (403, `missing_scopes` = the route scope, tenant row unchanged) |
|---|---|---|
| platform_owner | 6 / 6 | 10 / 10 |
| finance_admin | 6 / 6 | 10 / 10 |
| commercial_ops | 6 / 6 | 10 / 10 |
| catalog_manager | 6 / 6 | 10 / 10 |
| support_admin | 6 / 6 | 10 / 10 |
| read_only_auditor | 6 / 6 | 10 / 10 |
| super_admin (control) | 6 / 6 | admitted by the guard on 10 / 10 |

Plus 1 catalog test (live role scopes). The original A1 spec (`ccp-a1-platform-role-authorization.spec.ts`) re-run: 119 / 119.

## 3. E2E journeys per role (Playwright, mocked API harness)

`cd apps/platform-web && PW_E2E_PORT=4480 npx playwright test --project=journeys --workers=2` → **39 passed** (5.2 min; also green in 3 earlier runs).

| Role | Passed | Covers |
|---|---|---|
| platform_owner | 7 | rail + no money; catalog publish (Owner after Finance, no Apply); Finance-only chains refuse the Owner; contracts; audit trail; Finance + Owner account fills one step |
| finance_admin | 7 | Finance step of publish, escalated extension, conversion; no Apply; self-approval refused; contracts; audit |
| commercial_ops | 6 | conversion request → refused own approval → Finance → requester applies → audit; catalog view only; support disabled; contract amendment |
| catalog_manager | 4 | publish request → Finance → Owner → requester applies → timeline + audit; no Contracts (TD-B4-3); denied screens |
| support_admin | 6 | escalated extension → Finance → requester applies; bounded extension applies at once; tenant isolation spot check; conversion disabled |
| read_only_auditor | 6 | view only everywhere; no signing; no Apply; audit trail |
| super_admin | 3 | no Commercial group; access-denied card on every Commercial deep link; no tenant Commercial tab |

The journeys prove what the UI does with the server's answers; the server-side rules themselves are proved by §2.

## 4. UAT scripts

`doc/ccp/uat/CCP-UAT-<role>.md` for the 7 roles. Each states "Never run in production", one role per test account (D9-attested, a second same-role person where a chain needs distinct humans), numbered steps with expected results quoted from the UI, and negative checks (self-approval, not-requester apply, super_admin, catalog_manager and Contracts, tenant isolation, one person holding several roles). Two steps (Policy "Apply activation", the role-change applied message) take their text from source and are not exercised by a journey.

## 5. Validation

| Gate | Result |
|---|---|
| Suites | §2, §3 (all green) |
| `nx run-many -t lint -p platform-admin,aramo-platform-web --skip-nx-cache` | 0 errors (warnings only: pre-existing patterns, plus the `@nx/enforce-module-boundaries` disable comments the existing CCP specs also carry) |
| `npm run verify:vocabulary` | Tier 1 clean, Tier 2 clean, Front-Door clean |
| `npm run tests:integration:check` | PASSED (no new root) |
| repo-map | staged, `repo-map:generate`, `repo-map:check` (§6) |

## 6. Defects and observations

**HALTed defects: none.** Every negative control refused as required.

Observations (no production change made; for the Lead):

- **O-D4-1 (apply-deadline authoring).** The B5 policy draft PATCH DTO admits the eight format-1 keys only (`apps/platform-admin/src/app/platform/dto/commercial-governance.dto.ts:15-24`); `apply_expiry_hours` is an optional policy key the parser accepts (`libs/subscription/src/lib/commercial/commercial-policy.ts:38`) but no HTTP route can set it. D4-TTL-1 therefore writes the key into the DRAFT raw (the A6-R fixture precedent) before activating it. This bears on TD-ACC-1: activating "a v2 policy carrying the apply deadline" has no governed authoring path today.
- **O-D4-2 (refusal casing).** At the apply deadline `POST …/apply` reports `details.reason = 'apply_expired'` (`platform-commercial-apply.controller.ts:96`) while `POST …/convert` reports `APPLY_EXPIRED`. Both are 409 `COMMERCIAL_CHANGE_REQUEST_CONFLICT`; the clients see two spellings for one refusal.
- **O-D4-3 (intermittent false refusals under host load; not a passing negative control).** On this shared host (load average 45–57 during most runs) the negative-control suite had intermittent infrastructure failures, always fail-closed:
  - two requests that never answered (`socket hang up` in D4-TTL-1; a 300 s timeout in D4-NC2-D9), with the app's Prisma pools holding no live connection and no lock wait in `pg_stat_activity` / `pg_locks`;
  - one 401 `INVALID_TOKEN` with no `details.reason` for the requester's apply in D4-NC5-ROLE (ENTITLEMENT_GRANT). That shape comes only from the token-verification or key-import catch blocks (`libs/auth/src/lib/jwt-auth.guard.ts:136-155`), not from the resolver (`authz_unresolvable` / `authz_version_stale` carry a reason);
  - after the harness hardening below, one more D4-NC5-ROLE failure in one of three full runs (detail not captured; the test passes alone).
  The harness now sets `pool_timeout=60&connect_timeout=60` on its test `DATABASE_URL` and a 60 s request timeout that dumps `pg_stat_activity` and ungranted `pg_locks` on a hang. Full-suite runs after hardening: 15 / 15 (load 51), 14 / 15 (D4-NC5-ROLE), 15 / 15 (load 21); D4-NC5-ROLE alone: 1 / 1; D4-TTL-1 alone: 4 / 4. Recorded for the Lead as a flake to watch, not as a product defect: the failing calls were refusals of a legitimate requester, never an admission.
- **O-D4-4 (coverage limits).** 7 of the 13 isolation reads have no tenant-A row of that kind in the fixture (no-leak check only, §2.3). C4 (CREDIT / DISCOUNT apply) is NOT DELIVERED, so their controls stop at approval.
