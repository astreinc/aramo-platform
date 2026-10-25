# CCP-A3 — pre-execution check

Required by PBD §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-A3: change request, approval, eligibility |
| **Schedule** | Program Build Directive §5, row A3 |
| **Baseline** | `feat/ccp-commercial-control-plane` at `a44a2872` (A1 and A2 complete); `origin/main` `78dbd6d3` |

## Prerequisites
| Prerequisite | Evidence | Status |
|---|---|---|
| A2 evidence | `doc/ccp/slices/CCP-A2-acceptance.md` (`a44a2872`) | ✅ |
| **NC-5 rule** | **Proposed and ruled:** a signature stays valid; the request keeps its snapshotted policy version and chain; eligibility and chain fulfillability are **re-checked at APPLY**, and apply is refused if the chain is no longer satisfiable by currently eligible distinct humans. **Ruled by the PO on 2026-10-24** (`doc/ccp/decisions.md` Q5/NC-5). | ✅ PO-ruled. ⚠ The schedule names the Architect as confirmer, so this is recorded as **TD-A3-0** for Architect ratification at the program acceptance review. |
| Q1 activation chain | Finance → Owner (PO, 2026-10-24) | ✅ |
| Q14 | One open request per tenant × product (PO, 2026-10-24) | ✅ |

## Binding rules carried in
| Rule | Content |
|---|---|
| D6 chains | Finance then Owner above the policy thresholds and for catalog publish; Finance alone below threshold; owner/finance role grants need a distinct platform_owner; other role changes also need a distinct platform_owner (Q2). |
| D8 | `UNIQUE(change_request_id, approver_user_id)` and `UNIQUE(change_request_id, step_index)` in the database. Requester ≠ approver is enforced in the app/domain layer, **not** as a DB CHECK. R-SOD (Commercial-Approval Directive `:89-92`) is not reinterpreted. |
| D9 | A distinct-human requirement across approval steps (NC-2) |
| Policy | Chains and thresholds come from CommercialPolicyVersion (A2); the 72 h expiry follows TD-A2-1 (half-open) |
| Scope | **No apply** (A6). No domain data mutates in A3. |

## Correction-1 trigger check (PBD §2.4)
None.

## Path:line re-verification (recorded by the slice executor before the first commit)

Re-verified on `feat/ccp-commercial-control-plane` at `b0e59aa6` (the lead's NC-5 ratification commit on top of `247c93ab`; the only commit since the baseline above touches `doc/ccp/decisions.md` alone). Working tree clean before the first A3 edit.

**Instruments (SHA-256 recomputed, equal to the filed sidecars):**

| Instrument | SHA-256 |
|---|---|
| `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` | `8149cef2faf42335396a455d679eaac6bcb510e87bfac8bd067cbb849c5e9a95` (sidecar equal) |
| `Aramo-CCP-Program-Charter-v1_0-LOCKED.md` | `82d328eb11b586eb0df5d183d9c88c6899053c9257be7b5245f77e212c54b788` (sidecar equal) |
| `Aramo-Commercial-Approval-Directive-v1_0-LOCKED.md` (no sidecar) | `27a37cc941bd039f59932e82386db1c6112cb581f7e08f23f6af6473fbe9b64f`, equal to the Charter §9 row 10 citation |

**Citations the A3 row relies on:**

| Citation | Verified text / fact |
|---|---|
| PBD `:75` (§5.1 row A3) | the A3 row as quoted in the brief: in/out, mandatory tests, HALT conditions, acceptance evidence |
| Charter `:143` (D6), `:145` (D8), `:146` (D9), `:207-211` (NC-1…NC-5) | as cited; `:211` requires the Architect's confirmation of NC-5, now **RATIFIED** (`doc/ccp/decisions.md` TD-A3-0, Lead Architect 2026-10-25) |
| Commercial-Approval Directive `:89` | "**R-SOD (segregation of duties).** Default fail-closed maker-checker: `requested_by !==` …" (`:89-92`); A3 does not reinterpret it (D8) |
| Recon Report `:52-58`, `:64-65`, `:162` | the 7 refusals; `UNIQUE(change_request_id, approver_user_id)` / `UNIQUE(change_request_id, step_index)`; the change-request state machine |
| `libs/identity/src/lib/dto/scope.dto.ts:208`, `:575` | `'platform:approval:read'` in the platform scope catalog (both lists) |
| `libs/identity/prisma/seed.ts:3240` | `CCP_PLATFORM_ROLE_SEED_BUNDLES` (the A1 §4.1 bundles A3 relies on; unchanged) |
| `libs/auth/src/lib/auth-context.types.ts:30` | `PLATFORM_TENANT_SENTINEL_ID` (the platform tenant whose RBAC the live roster reads) |
| `libs/authorization/src/lib/roles.guard.ts:32` | "All-or-nothing on the scopes (every required scope must be present)." |
| `libs/identity/src/lib/role.repository.ts:118-149` | the platform token's membership filter (active membership, tenant-wide `site_id IS NULL`, active role) that the A3 live roster read mirrors |
| `libs/subscription/prisma/migrations/20261024180000_ccp_a2_commercial_audit_policy/migration.sql:158` | `"change_request_id" UUID,` with no FK; the A2 header defers the FK to A3 |
| `libs/subscription/src/lib/commercial/commercial-policy-boundaries.ts:138`, `:142` | `approvalExpiresAt` / `isApprovalExpired`: expired AT exactly `approval_expiry_hours` (TD-A2-1) |
| `libs/subscription/src/lib/billing/subscription-lifecycle.service.ts:578` | the billing advisory lock (`billing:<tenant>`); A3 takes no billing lock (no apply) |

**Recorded choices (this slice's):**
- **NC-5:** the rule ratified by the Lead Architect on 2026-10-25 (`doc/ccp/decisions.md` TD-A3-0). The HALT condition "NC-5 rule unconfirmed" is discharged.
- **Q14 product part:** a `product_key` column on the request, with **no DB default** (PBD §7.1), set explicitly by the service, and an interim closed CHECK of `sign` that CCP-A4 replaces with the governed registry. The one-open index is on (`tenant_id`, `product_key`) now; nothing is deferred to A4 (TD-A3-1).
- **D9:** a `CommercialOperatorAttestation` store (one active attestation per account and per attested human); no attestation means no approval (fail closed) (TD-A3-3).

No correction-1 trigger (§2.4) has arisen.
