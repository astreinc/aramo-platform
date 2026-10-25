# CCP-A6 — pre-execution check (lead-written prerequisites; the executor appends P-6 path:line)

| | |
|---|---|
| **Slice** | CCP-A6: transactional apply + D2/H5 hold |
| **Schedule** | PBD §5 row A6; Conversion Rule (`Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED`) |
| **Baseline** | `feat/ccp-commercial-control-plane` at `2bb41b23`. A1–A5 and A10 are committed and merged; A9 is in parallel. |

## Prerequisites
| Prerequisite | Evidence | Status |
|---|---|---|
| A3 evidence | `doc/ccp/slices/CCP-A3-acceptance.md`; NC-5 ratified by the Architect (`doc/ccp/decisions.md`) | ✅ |
| A5 evidence | `doc/ccp/slices/CCP-A5-acceptance.md`. TD-A5-1 (terms read from the pinned version) is pending Architect ratification. A6 builds on the pinned-version reading. | ✅ (flagged) |
| **Production DB privilege and cross-schema transaction facts (Charter §6.2)** | **Read-only check on 2026-10-25:** a single database `aramo` (PostgreSQL 17.11). api, sign-service and platform-admin all connect as role **`aramo`**, which is a **superuser** (`rolsuper=t`). Schemas `subscription`, `entitlement` and `identity` are **all owned by `aramo`**. The only other login role is `aramo_intelligence` (non-superuser, TI service). | ✅ |
| **Path decision** | **The single local DB transaction is feasible in prod:** one database, one owning role, and a raw cross-schema write on the caller's client (precedent: `insert-decision-record.ts`). **Recorded caveat:** the pending privilege-separation work (the S2 erasure blocker) would introduce per-schema roles. If that lands, the **outbox fallback** (Reconciliation Report §1 C3) becomes mandatory and needs a correction-1 check at that time. | ✅ single transaction |

## Binding rules
- NC-5 (ratified): re-check eligibility at apply under the SNAPSHOTTED policy version and chain. Fail closed with no mutation. Never rewrite signatures.
- The Conversion Rule:
  - checkout is refused under the billing lock;
  - webhook-time hold: raise a flag, keep the intent `CREATED`, record `IGNORED`;
  - hold reasons compose;
  - `APPLIED` only when both sides commit;
  - an external change is never reported as committed on local commit alone.
- Out of scope: Stripe commands (C1); the conversion workflow (C2); revoke (A7).
- **Production hold:** live Stripe, public signup and test checkout stay OFF in prod (verified 2026-10-25). A6 is built and tested locally only.

## Correction-1 trigger check
None.

## Path:line re-verification (executor)
_To be appended._
