# ADR-0030: External Lifecycle Authority

Status: ACCEPTED / LOCKED (PO ratified 2026-08-26).
Supersedes (for governed lifecycle transitions ONLY): the connector CREATE-only posture asserted in
libs/integration/prisma/schema.prisma, libs/integration/src/lib/domain/connector-actor.ts, and
apps/api/src/connector/connector-execution.orchestrator.ts (T8-CONNECTOR-A).
Relates: ADR-0024 (policy engine), ADR-0029 (I15 Pipeline-ATS wall — not implicated), ADR-0016.

## Context
The connector foundation (T8-CONNECTOR-A) is intentionally CREATE-only: "the connector never mutates a
requisition." Lane 1 now requires that an AUTHORITATIVE external client/VMS lifecycle event be able to
change the Requisition operating state — but THROUGH Aramo's governed lifecycle machinery, never as a
direct write. The two statements cannot coexist for the lifecycle-transition case; this ADR reconciles them.

## Decision (the new invariant — R-INVARIANT, LOCKED)
1. Connectors NEVER DIRECTLY mutate Requisition state. No connector/integration code may PATCH/update a
   requisition or write `RecruitingStatus` directly. (HARD PROHIBITION.)
2. Authoritative external lifecycle events MAY issue GOVERNED Requisition lifecycle COMMANDS — a mapped
   `TransitionAction` (CLOSE / REOPEN / PUT_ON_HOLD / CANCEL / ...), NEVER a target status — through the
   CANONICAL transition authority (the same gate -> CAS -> atomic lifecycle-event pipeline human actors use).
3. Every external command MUST traverse, and MUST NEVER bypass: ADR-0024 lifecycle POLICY (fail-closed),
   CAS/VERSION concurrency, the LEGAL TRANSITION MATRIX (governingAction), the ATOMIC AUDIT lifecycle event
   (stamped honest `origin:'integration'`, not `'ui'`), structured external PROVENANCE, TENANT ISOLATION,
   and RECONCILIATION handling (unsupported / contradictory / illegal-from-current-state / CAS-conflict ->
   reconciliation queue, NEVER a silent mutation).
4. AUTHORITY MODES (per-connection; tenant default):
   - EXTERNAL_AUTHORITY — a mapped external lifecycle event INVOKES the governed Requisition command.
     Astre DEFAULT.
   - DUAL_CONTROL — a mapped external event RECORDS intent / a pending-reconciliation state; it does NOT
     automatically complete the governed transition until internal control is satisfied.
   The data model supports both modes. (The full dual-control approval workflow is out of scope until a
   workflow exists; the substrate need only guarantee dual_control does NOT silently execute.)
5. THE COMMAND CHAIN (target architecture):
   Provider event -> provider normalization -> connection/client MAPPING CONTRACT -> AUTHORITY MODE ->
   mapped Aramo lifecycle ACTION -> GOVERNED Requisition command seam -> gateTransition -> CAS ->
   lifecycle event (origin=integration) -> external PROVENANCE record.
   If anything cannot safely proceed -> RECONCILIATION QUEUE.
   The direct-write path (provider status -> Requisition.status = ...) REMAINS FORBIDDEN.

## Consequences
- Requires a migration (client/connection mapping contract; reconciliation state; structured external
  transition provenance) and a NEW integration-mode governed-command seam (the current
  RequisitionRepository.update() is HTTP-PATCH-shaped, requires read-side visibility, and hardcodes
  origin:'ui').
- The connector service account gains authority to issue governed transitions SCOPED TO THE COMMAND SEAM,
  NOT general `requisition:edit`.
- The reconciler/composer lives in apps/api (connector-in-app + no-orchestration-bypass rulings; no I15
  relevance — all libs are scope:ats).
- Splits into D1 (this contract/seam/data-model/authority/ADR, proven with test event ingress) and D2
  (real Connector-B event intake + provider ordering/idempotency/watermarks + reconciliation-queue
  execution).
