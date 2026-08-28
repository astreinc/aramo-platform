# Aramo — Architecture Change History

Append-only, concise **semantic** records of retired/superseded architecture and
product surfaces. This file holds *decision* history — what changed, what
superseded it, and by whose authority — so a future engineer or recon does not
mistake a retired mechanism for current behaviour. **Do not copy old source
code here** — Git preserves line-level implementation history; this file
preserves the reasoning. Runtime source describes only the current system.

---

## Pipeline hard-delete retirement

- **Date / Lane:** 2026-08 · L2-B (Lane 2 DDR)
- **Current state:** No public Pipeline hard-delete. A recruiting episode is
  durable business history and closes through **terminal lifecycle semantics**
  (a terminal transition releases the live-episode slot; a new episode is created
  when no LIVE row exists). DB-enforced append-only `PipelineStatusHistory`.
- **Superseded behaviour:** `DELETE /v1/pipelines/:id` (public route),
  `PipelineRepository.delete()`, and the cascade-delete of episode history.
- **Reason:** Pipeline episodes are recruiting business history; ordinary product
  deletion would erase the audit. Removal is a lifecycle outcome, not a CRUD op.
- **Admin exception (retained, separately governed):** the tenant-reset service
  performs a privileged physical purge under the exact-value
  exact-value authorized tenant-reset GUC escape. That is administrative teardown /
  infra hygiene — NOT a public delete capability.
- **Authority:** L2-B directive / Lane 2 DDR / PR #709 (merge `9d4422cb`).

## Pipeline capacity-authority retirement (`openings_available` decrement)

- **Date / Lane:** 2026-08 · T4-B2 §6-7
- **Current state:** Requisition capacity is **DERIVED** = `max(capacity_balance, 0)`
  from the active ContractAssignment population (placement-owned). The public
  `openings_available` API field is unchanged (derived). A pipeline `placed`
  transition never mutates requisition capacity.
- **Superseded behaviour:** the PR-A5b-1 `placed`-edge cross-schema decrement of
  the **stored** `requisition.openings_available` column (dropped), its
  `openings_available > 0` over-capacity guard, the delete-restore `+1` inverse,
  and the `REQUISITION_NO_OPENINGS` (409) over-capacity refusal.
- **`REQUISITION_NO_OPENINGS`:** RESERVED / no longer emitted — kept in the error
  registry for compatibility (still mapped by the ats-web pipeline error-message map).
- **Reason:** capacity is a derived projection owned by placement, not a stored
  column a pipeline transition may mutate; over-capacity is a representable
  derived state, not a pipeline-time hard gate.
- **Authority:** T4-B2 directive.

## HYG-1 — repository residue reconciliation

- **Date / Lane:** 2026-08-28 · HYG-1 (hygiene predecessor to L2-C)
- **Current state / removed surfaces:**
  - Dead **Submittal-Policy write** substrate removed: `SubmittalPolicyRepository`
    (all three methods had zero callers — an L8-B1 write path that never landed a
    controller), its barrel export, and its module wiring. The live
    `RequisitionSubmittalEligibilityReader` + eligibility port + slot-consumption
    path are unaffected.
  - Orphaned RBAC scopes removed (zero enforcing route): **`pipeline:remove`**
    (its route/`delete()` were withdrawn at L2-B), **`pipeline:add-activity`** (no
    activity route ever wired), **`submittal-policy:write`** (the RBAC half of the
    dead cluster above).
  - Dead error code **`PRESIGNED_URL_EXPIRED`** removed across its full contract
    footprint (registry, HTTP-status map, OpenAPI enum, parity test) — zero
    emitter and, unlike `REQUISITION_NO_OPENINGS`, not a documented reserved code.
  - Four stale "obsolete-as-current" narratives rewritten to describe only the
    current system (pipeline repository header, error-codes header, the
    ats-batch4a test header, the false `submittal-policy:write` guard comment).
- **Reason:** the Aramo code-hygiene rule — a removed surface leaves zero live /
  product-contract residue; history lives here, not in dead production code.
- **Authority:** Architect ruling 2026-08-28 (relayed by PO) / HYG-1 directive.
- **Held (NOT removed) — see the Dead-Residue Ledger:** 8 ambiguous scopes whose
  lack of enforcement is insufficient to prove abandonment.
