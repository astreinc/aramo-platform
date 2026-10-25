# CCP-A9 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` §6.3 and the §5.1 A9 row.

| | |
|---|---|
| **Slice** | CCP-A9, bootstrap and governed role change (chain-satisfiability gate; last-effective-owner invariant) |
| **Worktree / baseline** | `.claude/worktrees/ccp-a9`, branch `wip/ccp-a9`, baseline `0294c905` (pre-execution record `doc/ccp/slices/CCP-A9-pre-execution.md`) |
| **Local commit SHAs** | committed on `wip/ccp-a9` (merged with `--no-ff`, SHAs preserved): `ae681cde` CCP-A9 A9-0: pre-execution check; `892a8ffa` CCP-A9 A9-1: PLATFORM_LAST_OWNER error code; `5bd30be4` CCP-A9 A9-2: last-effective-platform_owner DB invariant; `052dfd41` CCP-A9 A9-3: role-change apply path and bootstrap backstops (migration); `dc1d0e60` CCP-A9 A9-4: governance requesters, governed role change apply, D9 write paths; `f863c908` CCP-A9 A9-5: the one-time D7 platform-owner bootstrap command (never run in prod by this slice); `84b72d07` CCP-A9 A9-6: platform-admin invite accepts PLATFORM_ROLE_KEYS (arrivals only);  approve returns the apply; `3806a8f5` CCP-A9 A9-7: tests (bootstrap, gate, last-owner trigger, role change, NC-2/NC-4/NC-5, per-role routes, invite). Nothing is committed or pushed by the executor. |
| **HALT conditions hit** | None. The bootstrap needs no seed file and no `deploy/seed-prod.sh` change (both byte-unchanged, §8). There is no generalized bootstrap path: the command takes no user, email, tenant or role argument, is refused once it has granted or once another owner exists, and is backed by two DB one-time indexes. The apply choice (C-1) reinterprets no A3/A6 boundary (TD-A9-1). |

## 1. Changes and proposed commit map

13 new files, 25 modified files (38 in total), counted by `git status --short -uall`. `git diff --shortstat` over the modified files: 970 insertions, 54 deletions.

| # | Proposed commit | Files |
|---|---|---|
| A9-0 | `CCP-A9: pre-execution check` | `doc/ccp/slices/CCP-A9-pre-execution.md` (new) |
| A9-1 | `CCP-A9: PLATFORM_LAST_OWNER error code` | `libs/common/src/lib/errors/error-codes.ts`, `aramo-error.ts`; `libs/common/src/tests/error-codes.spec.ts`; `openapi/common.yaml` |
| A9-2 | `CCP-A9: last-effective-platform_owner DB invariant` | `libs/identity/prisma/migrations/20261025180000_ccp_a9_platform_last_owner_invariant/migration.sql` (new); `libs/common/src/lib/testing/identity-migrations.ts` (registered last); `libs/identity/src/lib/util/tenant-last-owner.ts` (409 mapping); `libs/identity/src/tests/ccp-a9-platform-last-owner.spec.ts` (new); `libs/identity/src/tests/ccp-a1-commercial-role-catalog-migration.integration.spec.ts` (registration pin re-pointed) |
| A9-3 | `CCP-A9: role-change apply path and bootstrap backstops (migration)` | `libs/subscription/prisma/migrations/20261025180100_ccp_a9_role_change_apply_bootstrap/migration.sql` (new) |
| A9-4 | `CCP-A9: governance requesters, governed role change apply, D9 write paths` | `libs/subscription/src/lib/commercial/commercial-change-request.ts`, `commercial-change-request.service.ts`, `commercial-operator.repository.ts`; `commercial-role-change.ts` (new); `libs/subscription/src/index.ts` |
| A9-5 | `CCP-A9: the one-time D7 platform-owner bootstrap command` | `libs/subscription/src/lib/commercial/commercial-platform-owner-bootstrap.ts` (new); `libs/subscription/scripts/ccp-bootstrap-platform-owner.ts` (new); `package.json` (`ccp:bootstrap-platform-owner`) |
| A9-6 | `CCP-A9: platform-admin invite accepts PLATFORM_ROLE_KEYS (arrivals only); approve returns the apply` | `apps/platform-admin/src/app/platform/platform-invitation.service.ts`, `platform.controller.ts`, `dto/invite-user.request.dto.ts`, `platform-commercial-change-request.controller.ts`, `dto/commercial-change-request.dto.ts`; `openapi/platform.yaml` |
| A9-7 | `CCP-A9: tests (bootstrap, gate, last-owner trigger, role change, NC-2/NC-4/NC-5, per-role routes, invite)` | `libs/subscription/src/tests/ccp-a9-bootstrap-role-change.integration.spec.ts`, `ccp-a9-role-change.spec.ts`, `support/ccp-a9-database.ts` (new); `apps/platform-admin/src/tests/ccp-a9-role-change-routes.integration.spec.ts`, `ccp-a9-role-change-authorization.spec.ts` (new); re-pointed: `libs/subscription/src/tests/commercial-change-request.integration.spec.ts`, `support/ccp-a3-database.ts`, `apps/platform-admin/src/tests/ccp-a3-commercial-change-request-routes.integration.spec.ts`, `platform-invitation.service.spec.ts` |
| A9-8 | `CCP-A9: acceptance evidence` + `CCP-A9: regenerate repo map` | `doc/ccp/slices/CCP-A9-acceptance.md` (new); `doc/generated/repo-map.{files,coupling,projects}.json` |

**Unchanged:** `deploy/seed-prod.sh`, `libs/identity/prisma/seed.ts`, `seed-platform-owner.ts`, `seed-astre.ts` (SHA-256 equal to the pre-execution baseline, §8); every existing migration; `doc/ccp/decisions.md`; `pact/`; `apps/api` sources; `apps/platform-web`. No new route, scope, role or nx edge.

## 2. What A9 delivers

**The D7 bootstrap command** (`runPlatformOwnerBootstrap`, CLI `npm run ccp:bootstrap-platform-owner -- --po-authorization-ref <ref> --human-ref-hash <sha256>`). One transaction under an advisory lock:
- It resolves the single user satisfying T2-F1-H3 `:28` (email `purush@aramo.ai`, sentinel membership, holding `super_admin`). The email and tenant are constants.
- If the target already holds `platform_owner` → `NOOP_ALREADY_GRANTED`, no write.
- It refuses `ALREADY_BOOTSTRAPPED` (a bootstrap event exists), `OTHER_PLATFORM_OWNER_EXISTS`, `TARGET_NOT_FOUND`, `TARGET_AMBIGUOUS`, `TARGET_INACTIVE`, `HUMAN_REF_IN_USE` and `INVALID_ARGUMENT`.
- Otherwise it grants exactly `platform_owner` on the existing membership (deterministic id, `ON CONFLICT DO NOTHING`), bumps the operator's `AuthorizationVersion`, writes the D9 attestation (method `BOOTSTRAP`, self) and exactly one `CommercialAuditEvent`. That event has `is_exception = true` and its payload carries `exception_kind: BOOTSTRAP`, `granted_source: MIGRATION`, the target user id, the role, the membership-role and attestation ids, the executing host context and the PO authorization reference.
- `super_admin` is kept; the seed-prod `:28` assertion still counts 1.
- It is never invoked by a seed or deploy script. **It was built and run against local test containers only; it was never run against production.**

**The governed role-change endpoint** is `POST /platform/commercial/change-requests` with `action_type` `ROLE_GRANT` / `ROLE_REVOKE` (pre-execution C-3).
- **Requester:** a `platform_owner` with a live role and an active D9 attestation (TD-A3-5).
- **Payload:** closed: `subject_user_id`, `role_key` (one of the 6 CCP roles, never `super_admin`) and, for a grant to an unattested subject, `human_ref_hash`.
- **Live create checks:** the subject is an active platform member, the role is held or not held as the action requires, the human reference is free, and a revoke of the last effective owner is refused (409 `PLATFORM_LAST_OWNER`).
- **Chain:** one step, a distinct `platform_owner`. The requester and the subject cannot fill it (`SELF_APPROVAL`; Q2, D6).
- **Apply:** the approval that completes the chain is followed, in its own transaction, by the apply (C-1, C-2). That transaction runs, in order:
  1. the NC-5 re-check of the signature against the snapshotted chain and the live roster;
  2. APPROVED → APPLYING;
  3. the identity role write, with the `AuthorizationVersion` bump;
  4. for a grant, the subject's D9 attestation if it is missing (method `PLATFORM_OWNER`, attested by the approving owner);
  5. APPLYING → APPLIED, with `applied_at`;
  6. the audit event.

  A refused apply rolls back, leaves the request APPROVED with its signatures untouched, and writes one `COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED` event. The approve response carries `apply: {applied, reason, detail}`.

**POLICY_ACTIVATE** is now created by a `finance_admin` (live role + D9). It is refused when its target version does not exist or is already ACTIVE. Its chain is finance → owner (Q1), and it is approved through the A3 engine. **It is not applied in A9** (TD-A9-16).

**The D9 write paths (TD-A3-3 closed):** the bootstrap (`BOOTSTRAP`), the governed grant apply (`PLATFORM_OWNER`), and the platform-admin invite of a commercial role (`PLATFORM_OWNER`, attested by the inviter, who must be an attested `platform_owner`).

**The platform-admin invite** accepts `role_keys` ⊆ `PLATFORM_ROLE_KEYS`. Absent means `['super_admin']`, the pre-A9 behaviour. The `@aramo.ai` domain allowlist is unchanged and checked first. The invite is **arrival only**: an existing platform member is refused 409 `INVITATION_ALREADY_EXISTS` `existing_platform_admin` (TD-A9-4).

**The last-effective-platform_owner invariant** is an identity migration cloned from ROLES-1. It covers:
- role DELETE and role re-point on `UserTenantMembershipRole`;
- membership DELETE, deactivation and re-point;
- `User.is_active` deactivation.

It uses an advisory lock, counts after the lock with `FOR SHARE`, and runs `ENABLE ALWAYS` with no GUC and no skip path. Its refusal marker `platform_last_owner` maps to 409 `PLATFORM_LAST_OWNER` both in the CCP service and in identity's `rethrowTenantLastOwner`.

**The chain-satisfiability gate** is the A3 gate (`checkChainSatisfiable`, 409 `CCP_NOT_BOOTSTRAPPED`), now reachable by the governance chains. It lifts per chain: A9-GATE-1, A9-RC-1, A9-RI-BOOT.

## 3. Mandatory tests (A9 row and brief) → test IDs and outputs

All on real Postgres 17 (Testcontainers) unless marked unit.

| Mandatory test | Test IDs | Output |
|---|---|---|
| 409 before chains are satisfiable | A9-GATE-1, A9-RC-1, A9-RI-BOOT, A9-RI-SUBJECT, A9-NC2-1 | With 5 platform users and no owner: a role change cannot be requested, and finance → owner approval → 409 `CCP_NOT_BOOTSTRAPPED`, while a finance-only credit approves (per chain, never a user count). After the bootstrap alone, the operator's own ROLE_GRANT → 409 `CCP_NOT_BOOTSTRAPPED`. Once a second attested owner exists, the same request approves and APPLIES. HTTP details: `action_type: ROLE_GRANT`, `chain_rule: DISTINCT_PLATFORM_OWNER`, `unfillable_steps: [0]`. |
| Single bootstrap exception, idempotent re-run | A9-BOOT-1, A9-BOOT-2, A9-BOOT-3, A9-BOOT-4 | GRANTED: roles `[platform_owner, super_admin]`; exactly 1 bootstrap event (`is_exception = true`, payload `BOOTSTRAP` / `MIGRATION` / PO ref / host); 1 `BOOTSTRAP` attestation. Row delta exactly +1 membership-role, +1 attestation, +1 audit event, +1 AuthorizationVersion; 0 user, membership, tenant, request or approval rows. The seed-prod `:28` assertion counts 1 before and after. Two re-runs (one with other argument values) → `NOOP_ALREADY_GRANTED` with every row count unchanged; the membership-role id is deterministic across databases. Refusals OTHER_PLATFORM_OWNER_EXISTS, ALREADY_BOOTSTRAPPED, TARGET_NOT_FOUND, TARGET_INACTIVE and HUMAN_REF_IN_USE each write nothing. DB backstops: a second `BOOTSTRAP` attestation → `CommercialOperatorAttestation_one_bootstrap_key`; a second bootstrap event → `CommercialAuditEvent_one_platform_owner_bootstrap_key`. |
| Takes no redirecting argument (unit) | A9-U-5, A9-U-6 (6 cases), A9-U-7 | Only `--po-authorization-ref` and `--human-ref-hash` are accepted. `--email`, `--user-id`, `--role`, `--tenant`, `--target` and a bare email are refused `INVALID_ARGUMENT` before any DB access; both flags are required, once each. |
| Last-owner trigger | A9-LO-1, A9-LO-2, A9-LO-3, A9-RC-4, A9-RI-LAST, A9-ID-0…3 (unit) | One owner: role DELETE, role re-point, membership deactivation and user deactivation each raise `platform_last_owner`, also under `session_replication_role = replica`. Two owners: one may go, then the second is refused. Unrelated removals with no owner are admitted (zero-to-zero). Two concurrent removals of the two owners: exactly one commits, the other raises `platform_last_owner`. Governed revoke of the last owner → 409 `PLATFORM_LAST_OWNER` at create. |
| Invite accepts platform role keys | A9-INV-1 (6 roles), A9-INV-2…8 (unit), A9-DTO-1 (7 keys), A9-DTO-2 (unit) | Each CCP role is minted on the sentinel in the platform pool, with the D9 attestation attested by the inviter. Omitted → `['super_admin']`. Domain allowlist is first. A commercial role needs `human_ref_hash` and an attested `platform_owner` inviter (403 `attester_not_platform_owner`); an in-use reference → 400. An existing platform member → 409 `existing_platform_admin`, with no role replacement and no Cognito call. A tenant-pool re-invite keeps its reconcile. Without the operator store, a commercial invite fails closed. |
| Role grant needs a distinct platform_owner | A9-RC-2, A9-RI-APPROVE, A9-RI-SUBJECT, A9-U-2 (unit) | The requester → `SELF_APPROVAL`; the subject (even an owner) → `SELF_APPROVAL`; a finance_admin → `STEP_SCOPE_MISSING`; a distinct owner → APPLIED. Granting `platform_owner` uses the same `DISTINCT_PLATFORM_OWNER` chain. All 6 role keys × grant/revoke resolve that chain. |
| NC-2 | A9-NC2-1, A9-RC-3 | A user holding platform_owner and finance_admin who requested the change cannot approve it (`SELF_APPROVAL`). A request by the only other owner, revoking that user, is `CCP_NOT_BOOTSTRAPPED`. A second account for the same human is refused (`CommercialOperatorAttestation_active_human_key`; `human_ref_in_use` at create). |
| NC-4 | A9-NC4-1, A9-RC-3 | An approver's `platform_owner` revoked between request and approval → `STEP_SCOPE_MISSING` (read live); with no other owner left → `CCP_NOT_BOOTSTRAPPED`; nothing applied. A requester whose token claims the role but whose live roster does not → `REQUESTER_ROLE_MISSING`. |
| NC-5 at apply (ratified rule) | A9-NC5-1 | Apply refused `ROLE_ALREADY_HELD`, then `APPROVER_NO_LONGER_ELIGIBLE` after the signer lost `platform_owner`. The request stays APPROVED, the `CommercialApproval` row is byte-identical (`row_to_json`) and the subject's roles are untouched. After eligibility returns it applies. An APPLIED request never re-applies (`NOT_APPROVED`). |
| Per-role allowed/refused routes (super_admin refused) | A9-RI-CREATE, A9-RI-APPROVE, A9-RI-400 (+ A3-RI-CREATE re-pointed) | The matrix in §4. |
| Guard (narrow apply) | A9-TRG-1, A9-POL-1, A9-U-4 (unit) | APPROVED → APPLYING → APPLIED only for role actions; APPLIED needs `applied_at`; APPLY_FAILED unreachable; an APPLIED row is frozen. `POLICY_ACTIVATE` APPROVED → APPLYING is refused. The A3 table still has exactly 6 allowed pairs. |

## 4. Per-role matrix (real guards + real service + real Postgres)

`ccp-a9-role-change-routes.integration.spec.ts`. Gate: `platform:approval:read` (A3). super_admin is refused at the gate: 403 `INSUFFICIENT_PERMISSIONS`, service never reached.

| Route / action | platform_owner | finance_admin | commercial_ops | catalog_manager | support_admin | read_only_auditor | super_admin |
|---|---|---|---|---|---|---|---|
| `POST /change-requests` ROLE_GRANT | **201** | 403 `requester_role_missing` | 403 | 403 | 403 | 403 | 403 (gate) |
| `POST /change-requests` ROLE_REVOKE | **201** | 403 | 403 | 403 | 403 | 403 | 403 (gate) |
| `POST /change-requests` POLICY_ACTIVATE | 403 `requester_role_missing` | **201** | 403 | 403 | 403 | 403 | 403 (gate) |
| `POST /:id/approvals` on a ROLE_GRANT requested by platform_owner | 409 SELF_APPROVAL (requester); **201 + APPLIED** for a distinct owner | 409 STEP_SCOPE_MISSING | 409 STEP_SCOPE_MISSING | 409 STEP_SCOPE_MISSING | 409 STEP_SCOPE_MISSING | 409 STEP_SCOPE_MISSING | 403 (gate) |
| `POST /platform/admins/invitations` (unchanged gate `platform:admin:invite`) | refused (A1 matrix) | refused | refused | refused | refused | refused | allowed; a commercial role also needs the inviter to be an attested platform_owner |

## 5. Tests and gates run and not run

Docker available. Exact counts.

| Run | Command | Result |
|---|---|---|
| A9 subscription integration | `ARAMO_RUN_INTEGRATION=1 vitest run --root libs/subscription src/tests/ccp-a9-bootstrap-role-change.integration.spec.ts --maxWorkers=1` | **17 / 17** |
| subscription full (unit + integration) | `ARAMO_RUN_INTEGRATION=1 vitest run --root libs/subscription --maxWorkers=2` | **18 / 18 files, 347 / 347 tests** |
| subscription unit | `vitest run --root libs/subscription` | 8 passed, 10 skipped files; 187 passed, 160 skipped |
| platform-admin full (unit + integration, AppModule-booting specs included) | `ARAMO_RUN_INTEGRATION=1 vitest run --root apps/platform-admin --maxWorkers=2` | **20 / 20 files, 449 / 449 tests** |
| platform-admin unit | `vitest run --root apps/platform-admin` | 11 / 11 files, 325 / 325 |
| identity full (unit + integration; every spec applying `IDENTITY_MIGRATIONS` gets the A9 trigger) | `ARAMO_RUN_INTEGRATION=1 vitest run --root libs/identity --maxWorkers=2` | 84 files: 80 passed, 4 failed; 949 tests: 948 passed, 1 failed. The 1 assertion failure was the CCP-A1 "last identity migration" pin, re-pointed (TD-A9-15). The other 3 files failed `Hook timed out in 10000ms` at load average 24. Re-run of those 4 files (`--maxWorkers=1`): **4 / 4 files, 39 / 39 tests** |
| identity unit | `vitest run --root libs/identity` | 62 / 62 files, 724 / 724 |
| common | `vitest run --root libs/common` | 12 passed, 1 skipped files; 83 passed, 2 skipped (error-code parity included) |
| lint | `nx run-many -t lint -p subscription platform-admin common identity --skip-nx-cache` | 0 errors (43 / 89 / 3 / 51 warnings; none in an A9 file) |
| build, CI-simulated | `nx run-many -t build -p subscription platform-admin common identity api sign-service --skip-nx-cache` | 6 projects + 73 dependency tasks succeeded; `dist/libs/subscription/src/index.d.ts` exports `runPlatformOwnerBootstrap` (HEAD marker checked) |
| typecheck | `nx run-many -t typecheck -p subscription platform-admin common identity --skip-nx-cache` | 4 / 4 |
| `orphan-scopes:check`, `orphan-scopes:self-test` | temporary index (TD-A9-21) | ok; self-test ok |
| `contract-parity:check` | temporary index | 677 live routes (675 governed), 508 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified (unchanged from A3: no new route) |
| `openapi:drift-check` | | ok (9 files) |
| `redocly lint openapi/platform.yaml` | | valid; the 2 pre-existing warnings only. `openapi/common.yaml`: valid, 40 warnings, the same count as at `HEAD` |
| `error-codes:check`, `dead-error-codes:check` | | ok, ok |
| `tests:integration:check`, `pg-test-image:check`, `env:passthrough-check`, `api-spec-location:check` | | pass (49 roots; all callers on `ARAMO_POSTGRES_TEST_IMAGE`; 107 + 3 + 2 env, no new var) |
| `libs/identity/scripts/scope-catalog-consistency.mjs` | | PASS (CCP A1 matrix: 6 roles, 45 rows; super_admin commercial scopes 0) |
| `bash scripts/verify-vocabulary.sh` | | exit 0; Tier 1, Tier 2, front-door clean |
| `repo-map:generate` / `repo-map:check` | temporary index | generated (3 files modified); `repo-map:check ok` |

**Load note.** One concurrent run of the A3 and A9 subscription integration files together (load average 23) produced 9 failures: test and hook timeouts after a 34 s test. Each file alone and the full subscription suite above are green. The cause is the same as TD-A3-22.

**Not run:**
- The full `ARAMO_RUN_INTEGRATION=1 nx run api` suite (brief; CI runs it). A9 changes no `apps/api` source; the api build succeeded. apps/api specs that apply `IDENTITY_MIGRATIONS` and glob the subscription migrations pick up both A9 migrations. Both are additive, and the trigger fires only when an effective `platform_owner` row is removed (no api fixture creates one).
- Pact (`verify-api`, `verify-sign`). No returned shape of an apps/api route changes, so nothing is registered in `verify-api.ts`. The platform-admin response additions (`applied_at` on the change request; `apply` on the approval envelope; invite `role_keys` / `human_ref_hash`) are for CCP-A10's contracts (TD-A9-17).
- **The bootstrap command against any non-test database, and in particular production: not run** (A1-2(7); brief).

**Sufficiency.** Every A9 surface ran on real Postgres: the triggers, the unique backstops, the advisory-lock concurrency, the live RBAC and attestation reads, and the cross-schema apply transaction. The routes ran through the real guard chain, and the platform-admin AppModule-booting specs construct the changed DI graph. Residual risks: the CI-only full api suite, the A10 contracts, and A6's future guard replacement (TD-A9-1).

## 6. Recovery and rollback

- **Code:** revert the A9 commits. The A3 creation refusal for governance actions returns.
- **A role change:** reversed by the opposite governed request (`ROLE_REVOKE` / `ROLE_GRANT`).
- **The bootstrap grant:** reversed only by a governed `ROLE_REVOKE` once another effective owner exists. The bootstrap never revokes (Inc-1 A1-4).
- **Break-glass** (PBD A9 row; ROLES-1 `:92`): superuser, PO-authorized `ALTER TABLE … DISABLE TRIGGER` for the five `ccp_a9_platform_last_owner_*` triggers, then re-enable with `ENABLE ALWAYS`. The D5 runbook is to document it.
- **Compensating migrations (documented, not shipped; never run against production, PBD §7.5):**
  - *Subscription:* in one transaction, `RAISE` if any `CommercialChangeRequest` is APPLYING or APPLIED; re-create the CCP-A3 body of `guard_commercial_change_request()` (from `20261025120000`); `DROP INDEX "subscription"."CommercialOperatorAttestation_one_bootstrap_key"`, `"subscription"."CommercialAuditEvent_one_platform_owner_bootstrap_key"`.
  - *Identity:* drop the five `ccp_a9_platform_last_owner_*` triggers and the four `identity.ccp_a9_*` functions.

## 7. Typed divergences

| ID | Divergence | Disposition |
|---|---|---|
| **TD-A9-1** | **Narrow role-change apply in A9** (pre-execution C-1). The A9 subscription migration replaces `guard_commercial_change_request()` with the A3 body plus APPROVED → APPLYING → APPLIED for `ROLE_GRANT` / `ROLE_REVOKE` only. The A3 comment said the APPLYING states were unreachable "until CCP-A6 replaces this function". | Recorded for the lead. **Merge coordination: A6's guard replacement MUST keep the two role-only transitions** (or A6 must re-home role apply). A6's row covers subscription/entitlement apply only, so no instrument boundary moves. |
| TD-A9-2 | The role-change endpoint is the A3 route with `action_type` ROLE_GRANT / ROLE_REVOKE. The recon path `POST /platform/admins/:user_id/role-change-requests` (Inc-1 A1, "the CCP-A9 pre-execution record fixes it") is not added. | Pre-execution C-3. B5 calls the A3 route. |
| TD-A9-3 | A refused role-change apply leaves the request **APPROVED**; APPLY_FAILED is unused and there is no HTTP retry route. `applyRoleChange` is callable in-process. A role request holds no Q14 slot (not tenant-scoped), so a fresh request is the operator path. | Pre-execution C-2. |
| TD-A9-4 | **Behaviour change:** a platform-pool invite of an existing platform member previously replaced the role set (`roles_updated`). It is now 409 `INVITATION_ALREADY_EXISTS` `existing_platform_admin` for any role set. The tenant pool is unchanged. platform-web already maps the code to "This person is already a platform admin." | Required by Inc-1 A1 A1-1, A1-5 (no invite variant grants to an existing user); the old path could strip `platform_owner`. |
| TD-A9-5 | An invite carrying a CCP role needs `human_ref_hash` and an inviter who is an attested `platform_owner` (the D9 attester; method `PLATFORM_OWNER`). The attestation is written after the identity user exists (Cognito-first flow, not atomic). A lost race on the human reference → 400 `attestation_not_recorded`, and the arrival stays unattested (NOT_HUMAN, fail closed). | Executor reading of D9 ("required for every holder of a commercial role"). PO to confirm, with the `D9-v1` statement (TD-A3-3). |
| TD-A9-6 | `PlatformInvitationService` takes `CommercialOperatorRepository` as `@Optional()`. PlatformModule always provides it. When it is absent, a commercial-role invite is refused 500 `commercial_operator_store_unavailable` before Cognito. This avoids 5 identical edits to slim integration test modules. | Fail closed; A9-INV-8. |
| TD-A9-7 | The requester's D9 attestation is required for the A9 **governance** actions only. A3 actions (subscription, billing, catalog, support) still accept an unattested requester; the A3 gate excludes the requester but does not verify that they are an attested human. | Flag for the Architect: whether A1-3 ("distinct, active, independent eligible humans to the requester and every approval step") should extend requester attestation to every action. Changing it would re-point A3 tests. |
| TD-A9-8 | The invariant applies **whenever** an effective owner exists, which is stricter than "once the bootstrap has granted the first platform_owner". Before the bootstrap no owner can exist except by raw SQL. The effective-holder definition is A1-4's literal one (active User, active sentinel membership, the role); unlike the A3 roster it does not filter `site_id IS NULL`. | Stricter and fail-closed; the zero-to-zero state is admitted. |
| TD-A9-9 | Every role write bumps the subject's `AuthorizationVersion` (HF-AUTH-1), the bootstrap included (+1 row or +1 version). That is not one of A1-2(2)'s prohibited objects (user, membership, tenant, credential, Cognito). | Consistency with every identity role write. |
| TD-A9-10 | `CommercialAuditEvent` has no `granted_source` or `kind` column. `exception_kind: BOOTSTRAP` and `granted_source: MIGRATION` are in the event payload, and `is_exception = true` is the column. | A2 schema unchanged. |
| TD-A9-11 | CCP role changes write `CommercialAuditEvent` rows, not `identity.IdentityAuditEvent`. | The CCP audit stream is the record (A2). Flag whether identity's tenant audit should mirror it. |
| TD-A9-12 | New error code `PLATFORM_LAST_OWNER` (409), touching `libs/common` and `openapi/common.yaml`. Identity's `rethrowTenantLastOwner` also maps the platform marker, so an identity path that would remove the last owner returns 409, not 500. | Registry append-only; parity and dead-code gates pass. |
| TD-A9-13 | The bootstrap CLI lives at `libs/subscription/scripts/ccp-bootstrap-platform-owner.ts`, with npm script `ccp:bootstrap-platform-owner` in `package.json`. It is not wired into any deploy script. | A1-2(1). |
| TD-A9-14 | The shared A3 test helper's fixture attestations moved from method `BOOTSTRAP` to `PLATFORM_OWNER` (fixed fixture attester), because A9 admits one `BOOTSTRAP` attestation ever. | Test-only. |
| TD-A9-15 | Re-pointed existing tests: A3-INT-3 (POLICY_ACTIVATE by a platform_owner → `REQUESTER_ROLE_MISSING`); A3-NC2-2, A3-NC3-1, A3-NC5-a (an extra or earlier owner so that revoking "the only owner" does not hit the last-owner trigger; the intent of each is unchanged); A3-RI-CREATE's POLICY_ACTIVATE row; the CCP-A1 identity "last migration" registration pin. | Consequences of TD-A3-5 and A1-4. |
| TD-A9-16 | `POLICY_ACTIVATE` can be requested and approved but is **not applied** by any slice yet; the guard refuses APPLYING for it. | The PBD names no applying slice for policy activation (A2 "re-activate the prior policy version (a change request once A3 exists)"). Needs a lead ruling: A6 or B5. |
| TD-A9-17 | Response additions on CCP routes: `applied_at` on `CommercialChangeRequest`; `apply` on the approval envelope; invite request `role_keys` and `human_ref_hash`. No new route. | Recorded for CCP-A10's consumer contracts (built in parallel). |
| TD-A9-18 | Merge hotspots with the parallel A5 / A10 worktrees: the `ERROR_CODES` tuple and status map, `openapi/common.yaml` enum, `openapi/platform.yaml`, `libs/subscription/src/index.ts`, `IDENTITY_MIGRATIONS`, the repo-map JSON. | Lead merges; regenerate the repo map after the merge. |
| TD-A9-19 | Through the governed path the platform can never reach zero owners: the approver must be a distinct live owner, re-checked at apply, and the subject differs from the approver. So the trigger's refusal is proven with raw SQL (A9-LO-1…3) and the create-time pre-check (A9-RC-4, A9-RI-LAST), not through an apply. | Structural. |
| TD-A9-20 | The concurrent A3 + A9 subscription run under load timed out (§5 load note). | As TD-A3-22; rerun on an idle host before the push. |
| TD-A9-21 | The repo-map, orphan-scope and contract-parity gates ran under a temporary `GIT_INDEX_FILE` with intent-to-add entries for the 13 new paths; the real index is untouched. | As TD-A3-20. Re-run `npm run repo-map:generate` if the staged set differs. |

## 8. Byte-unchanged proofs

| File | SHA-256 at acceptance | Equal to the pre-execution baseline |
|---|---|---|
| `deploy/seed-prod.sh` | `638d5ea915adc7ff95926c4936db754e38e34efd49d10aa7f44a8e0927d1d7ec` | yes |
| `libs/identity/prisma/seed.ts` | `4962f95368e984e2f12709fadba6b02cc5e728353dbe9160d42a93ca2f477f4a` | yes |
| `libs/identity/prisma/seed-platform-owner.ts` | `274e405f955e2fcadd9430b3d7568db2e42e894daae31e312fb756e257641234` | yes |
| `libs/identity/prisma/seed-astre.ts` | `69c3f2f889adab5b5cb797560a554bbcd2fd7801bd1a0f190171b1cd11a25b8a` | yes |

A9-SEED-1 also asserts that none of these four files references the bootstrap command or the attestation table, and that the seed-prod `:28` assertion stays filtered on the super_admin role id.

## 9. Vocabulary result

`bash scripts/verify-vocabulary.sh`: exit 0; Tier 1, Tier 2 and front-door clean. No exemption added.
