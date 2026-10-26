# CCP-A9 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` §6.2 and the §5.1 A9 row. Recorded before the slice's first change.

| | |
|---|---|
| **Slice** | CCP-A9, bootstrap and governed role change (chain-satisfiability gate; last-effective-owner invariant) |
| **Worktree / branch** | `.claude/worktrees/ccp-a9`, branch `wip/ccp-a9` |
| **Baseline** | `0294c905f24f40fd1b70f5f9d3aca517bfcbd237` (CCP-A4 merged onto the program branch). Drift since the cut: 0 commits. A5 and A10 are built in parallel in other worktrees; nothing from them is on this baseline. |
| **Governing text** | PBD §2, §5.1 row A9, §6, §7; T2-F1-H3 Amendment A1 (A1-0 … A1-4, A0-C1, D7); Inc-1 Closure Amendment A1 (A1-1 … A1-6); Charter §5.1 D6/D7/D9, §6.3; Reconciliation Report §1 C4; `doc/ccp/decisions.md` Q2, TD-A3-0 (NC-5 ratified), TD-A3-5, TD-A3-6 |

## 1. Prerequisites (A9 row)

| Prerequisite | Evidence |
|---|---|
| A1 evidence | `doc/ccp/slices/CCP-A1-acceptance.md` (6 roles, 15 scopes, 45 role-scope rows; super_admin 10 scopes, 0 commercial) |
| A2 evidence | `doc/ccp/slices/CCP-A2-acceptance.md` (append-only `CommercialAuditEvent` with `is_exception`; ACTIVE policy v1). A1-2(5) "until A2 exists, the command SHALL NOT run" is satisfied. |
| A3 evidence | `doc/ccp/slices/CCP-A3-acceptance.md` (change request, approval, D9 attestation store, the chain-satisfiability gate `checkChainSatisfiable`, NC-1…NC-5) |
| T2-F1-H3 Amendment A1 LOCKED | `Aramo/locked/Aramo-T2-F1-H3-…-Amendment-A1-CCP-Confirmation-v1_0-LOCKED.md` + `.sha256` sidecar present |
| Inc-1 Closure Amendment A1 LOCKED | `Aramo/locked/Aramo-Platform-Console-Increment-1-Closure-Record-Amendment-A1-CCP-Role-Grants-v1_0-LOCKED.md` + `.sha256` sidecar present |

## 2. `path:line` re-verified at the baseline

| Reference | Verified text |
|---|---|
| `apps/platform-admin/src/app/platform/platform-invitation.service.ts:826` | `role_keys: ['super_admin'],` (the invite mints only super_admin) |
| `libs/identity/src/lib/dto/role.dto.ts:142` | `export const PLATFORM_ROLE_KEYS = [` (super_admin + the 6 CCP A1 roles) |
| `libs/subscription/src/lib/commercial/commercial-change-request.ts:76-78` | `POLICY_ACTIVATE`, `ROLE_GRANT`, `ROLE_REVOKE` carry `requester_scope: null` (TD-A3-5: creation refused, `requester_authority_undefined`) |
| `libs/subscription/prisma/migrations/20261025120000_ccp_a3_change_request_approval/migration.sql:167` | the guard comment: APPLYING / APPLIED / APPLY_FAILED unreachable until a later slice replaces `guard_commercial_change_request()` |
| `libs/subscription/src/lib/commercial/commercial-operator.repository.ts:121` | `recordAttestation` exists; no caller and no HTTP write path (TD-A3-3) |
| `libs/subscription/src/lib/commercial/commercial-change-request.service.ts:418` | the A9 chain gate in `approve` (`checkChainSatisfiable`, 409 `CCP_NOT_BOOTSTRAPPED`) |
| `libs/identity/prisma/migrations/20261021120100_roles1_last_owner_invariant/migration.sql:31-65` | the ROLES-1 `tenant_last_owner` trigger set (the clone model, A1-4) |
| `libs/auth/src/lib/auth-context.types.ts:30` | `PLATFORM_TENANT_SENTINEL_ID` (`01900000-0000-7000-8000-000000000100`) |
| `deploy/seed-prod.sh:224` | the `:28` assertion SQL, filtered on the super_admin role id `…00001d` |
| `libs/common/src/lib/testing/identity-migrations.ts` | `IDENTITY_MIGRATIONS`, last entry `20261024120000_ccp_a1_commercial_role_catalog` (the A9 identity migration is appended after it) |

**Byte-unchanged baselines (SHA-256, checked again at acceptance):**

| File | SHA-256 |
|---|---|
| `deploy/seed-prod.sh` | `638d5ea915adc7ff95926c4936db754e38e34efd49d10aa7f44a8e0927d1d7ec` |
| `libs/identity/prisma/seed.ts` | `4962f95368e984e2f12709fadba6b02cc5e728353dbe9160d42a93ca2f477f4a` |
| `libs/identity/prisma/seed-platform-owner.ts` | `274e405f955e2fcadd9430b3d7568db2e42e894daae31e312fb756e257641234` |
| `libs/identity/prisma/seed-astre.ts` | `69c3f2f889adab5b5cb797560a554bbcd2fd7801bd1a0f190171b1cd11a25b8a` |

## 3. Choices the schedule leaves to this record

| # | Choice | Decision | Confirmation needed |
|---|---|---|---|
| C-1 | **Apply of an approved role change** (A3 guard keeps APPLYING / APPLIED unreachable "until A6") | **A narrow role-change apply path inside A9.** A new subscription migration replaces `guard_commercial_change_request()` with the A3 body plus exactly two transitions, `APPROVED → APPLYING → APPLIED`, admitted **only** for `ROLE_GRANT` / `ROLE_REVOKE`. APPLY_FAILED stays unreachable. Every other action type keeps the A3 behaviour. Rationale: the A6 row's "In" is subscription and entitlement operations (MANUAL open/change/end + entitlement grant); role changes are not in it, and the A9 row's "In" is the governed role-change request, which per Inc-1 A1-3(a) is the path by which the grant "SHALL be made". No A3/A6 boundary is reinterpreted: A6 still owns every commercial apply, and when A6 replaces the guard function it must keep these two role-only transitions (typed divergence TD-A9-1, recorded for the lead). | Lead (merge coordination with A6) |
| C-2 | Apply timing | Auto-apply in a **second transaction** right after the approval that completes the chain commits. A refused apply (NC-5 re-check, last-owner trigger, role already held / not held, attestation conflict) rolls its transaction back, leaves the request **APPROVED** with its signatures untouched, and writes one `COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED` audit event. No retry route in A9. | — |
| C-3 | Role-change endpoint path (Inc-1 A1 open issue 3) | **The existing A3 route** `POST /platform/commercial/change-requests` with `action_type` `ROLE_GRANT` / `ROLE_REVOKE` and `payload.subject_user_id`, `payload.role_key`. No second route: the request lifecycle (submit, approvals, reject, read) is the A3 one, and A10's contracts cover one surface. The recon path `POST /platform/admins/:user_id/role-change-requests` is not added (TD-A9-2). | — |
| C-4 | Requester authority for governance actions (TD-A3-5) | Role-based, read **live** in the create transaction: `ROLE_GRANT` / `ROLE_REVOKE` → the requester holds `platform_owner`; `POLICY_ACTIVATE` → the requester holds `finance_admin`. The requester must also hold an active D9 attestation (A1-3 counts the requester as one of the distinct independent humans). The A1 catalog has no governance request scope, so the role is the authority (as TD-A3-6 for steps). | — |
| C-5 | Grantable roles | The 6 CCP roles only. `super_admin` can be neither granted nor revoked through the CCP (T2-F1-H3 A1-1). | — |
| C-6 | D9 attestation write paths (TD-A3-3) | (a) the bootstrap: method `BOOTSTRAP`, self; (b) the governed `ROLE_GRANT` apply when the subject has no active attestation: method `PLATFORM_OWNER`, attested by the platform_owner who approved the grant, human reference from the request payload (`human_ref_hash`, frozen by the payload checksum); (c) the platform-admin invite when it carries a CCP role: method `PLATFORM_OWNER`, attested by the inviter, who must be an attested `platform_owner`. | PO (attestation statement `D9-v1`, carried from TD-A3-3) |
| C-7 | Invite for existing platform members | The platform-pool invite is **arrival only**: an existing sentinel member is refused 409 `INVITATION_ALREADY_EXISTS` (`details.reason` `existing_platform_admin`) whatever the role set. Before A9 a different role set was silently replaced (`roles_updated`), which would be a third grant path (Inc-1 A1-5) and could strip `platform_owner`. | — |
| C-8 | Last-owner invariant form | Identity migration cloning ROLES-1: same trigger coverage, advisory lock per platform, `ENABLE ALWAYS`, no GUC or skip path. Checked only when the removed row counted as an effective owner, so the pre-bootstrap zero-to-zero state is admitted. No tenant-status condition (A1-4 has none). Refusal marker `platform_last_owner`, mapped to a new 409 `PLATFORM_LAST_OWNER`. | — |
| C-9 | Bootstrap one-time backstop | Besides the command's own checks, two DB partial unique indexes: one `BOOTSTRAP` attestation ever, and one `COMMERCIAL_PLATFORM_OWNER_BOOTSTRAPPED` audit event ever. | — |
| C-10 | Chain-specific "not bootstrapped" reason (T2-F1-H3 A1 open issue 3) | Keep A3's 409 `CCP_NOT_BOOTSTRAPPED`; `details` already names `action_type`, `chain_rule` and `unfillable_steps`. | — |

## 4. Correction-1 triggers (§2.4)

None has arisen. C-1 adds no architectural change: it uses the A3 state machine's defined states and the A3 apply-time check; it crosses no nx edge (raw cross-schema SQL in the caller's transaction, the TD-A3-4 precedent). No new regulatory or commercial decision and no governing-contract amendment is needed. The production execution of the bootstrap stays out of scope (separate PO authorization, A1-2(7)); it is built and tested locally only.
