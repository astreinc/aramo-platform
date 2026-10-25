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
_To be appended._
