# CCP-A2 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-A2: commercial audit + CommercialPolicyVersion v1 |
| **Schedule** | Program Build Directive §5, row A2 |
| **Baseline** | `feat/ccp-commercial-control-plane` at `f1527e76` (CCP-A1 complete, 10 local commits on `origin/main` `78dbd6d3`). `origin/main` re-fetched: `78dbd6d3`. |

## Prerequisites
| Prerequisite | Evidence | Status |
|---|---|---|
| A1 evidence recorded | `doc/ccp/slices/CCP-A1-acceptance.md` (commit `6b024ac3`) | ✅ |
| Charter §7 values (D5) | Policy v1: discount escalation 20%; credit escalation $500 (USD); support extension 14 days; once per 90 days; 30 days cumulative; approval expiry 72 h; past-due grace 7 days | ✅ |
| **Boundary semantics (Charter §14 item 2)** | **Confirmed by the PO on 2026-10-24** (see below) | ✅ |

## Boundary semantics (PO-confirmed 2026-10-24)
| Rule | Semantics |
|---|---|
| Discount escalation | A discount **≥ 20%** escalates to the owner (inclusive). 19.99% does not. |
| Credit escalation | A credit **≥ $500.00** (USD minor units ≥ 50000) escalates to the owner (inclusive). |
| Support extension length | An extension of **≤ 14 days** is within limit. 15 days or more escalates. |
| Extension frequency | **Rolling 90 days:** within limit only if no in-limit extension was applied to the same tenant × product in the 90 days before now. |
| Cumulative cap | **Rolling 12 months:** in-limit extensions for a tenant × product total **≤ 30 days** in any rolling 365-day window. An extension that would exceed the cap escalates. |
| Approval expiry | A request expires **72 h** after it is submitted. At exactly 72 h it is expired. |
| Past-due grace | **7 days**, and it remains a policy value (today the code reads it from env `BILLING_PAST_DUE_GRACE_DAYS`, default 7). |

All values are **policy data** in CommercialPolicyVersion v1, not code constants.

## Correction-1 trigger check (PBD §2.4)
None has arisen. No separate LOCKED directive is required.

## Path:line re-verification (recorded by the slice executor before the first commit)
_To be appended._
