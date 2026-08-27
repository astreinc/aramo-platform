// CB-D2-R (ADR-0030, R-TAXONOMY LOCK) — the ONE authoritative reconciliation
// vocabulary, co-located where BOTH writers (external-lifecycle-reconciler.ts,
// lifecycle-ingress.service.ts) and the draining worker import it. The two
// writers emit via RECONCILIATION_FAILURE_REASON (no bare literals); the worker
// classifies via classifyReconciliation. The schema comment's historical "6" is
// stale — the ingress adds the two ORDERING tokens, so the real set is 8.

// The 8 entry-cause tokens a writer can record on a reconciliation row. This is
// the failure_reason column's bounded domain (the ENTRY cause — never repurposed
// as worker state; the worker records its disposition in resolution_reason).
export const RECONCILIATION_FAILURE_REASON = {
  UNMAPPABLE_PROVIDER_STATE: 'UNMAPPABLE_PROVIDER_STATE',
  REQUISITION_NOT_FOUND: 'REQUISITION_NOT_FOUND',
  CAS_CONFLICT: 'CAS_CONFLICT',
  ILLEGAL_FROM_STATE: 'ILLEGAL_FROM_STATE',
  POLICY_DENIED: 'POLICY_DENIED',
  ORDERING_STALE: 'ORDERING_STALE',
  ORDERING_AMBIGUOUS: 'ORDERING_AMBIGUOUS',
  DUAL_CONTROL_PENDING: 'DUAL_CONTROL_PENDING',
} as const;

export type ReconciliationFailureReason =
  (typeof RECONCILIATION_FAILURE_REASON)[keyof typeof RECONCILIATION_FAILURE_REASON];

// The exhaustive token list (for the exhaustiveness proof + iteration).
export const RECONCILIATION_FAILURE_REASONS: readonly ReconciliationFailureReason[] =
  Object.values(RECONCILIATION_FAILURE_REASON);

/** True iff the token is a recognized reconciliation entry cause. */
export function isReconciliationFailureReason(
  value: string,
): value is ReconciliationFailureReason {
  return (RECONCILIATION_FAILURE_REASONS as readonly string[]).includes(value);
}

// The LOCKED 4-way drain class (R-TAXONOMY):
//   RE_EVALUABLE — auto-re-attempt (bounded): re-check mapping/identity, reload +
//     re-derive, and re-run the GOVERNED command seam.
//   SUPERSEDED   — a newer observation already applied; mark resolved, NO mutation.
//   INTERVENTION — park after bounded attempts; NEVER auto-execute a transition.
//   EXCLUDED     — never drained by CB-D2-R (awaits a future control workflow).
export type ReconciliationClass =
  | 'RE_EVALUABLE'
  | 'SUPERSEDED'
  | 'INTERVENTION'
  | 'EXCLUDED';

/**
 * Map an entry-cause token to its LOCKED drain class. The switch is exhaustive by
 * construction — a new token added to RECONCILIATION_FAILURE_REASON without a case
 * here fails the type-check (the `never` assertion), so no token is silently
 * mis-drained.
 */
export function classifyReconciliation(
  reason: ReconciliationFailureReason,
): ReconciliationClass {
  switch (reason) {
    case 'UNMAPPABLE_PROVIDER_STATE':
    case 'REQUISITION_NOT_FOUND':
    case 'CAS_CONFLICT':
      return 'RE_EVALUABLE';
    case 'ORDERING_STALE':
      return 'SUPERSEDED';
    case 'ILLEGAL_FROM_STATE':
    case 'POLICY_DENIED':
    case 'ORDERING_AMBIGUOUS':
      return 'INTERVENTION';
    case 'DUAL_CONTROL_PENDING':
      return 'EXCLUDED';
    default: {
      const unhandled: never = reason;
      throw new Error(`unclassified reconciliation failure reason: ${String(unhandled)}`);
    }
  }
}

// The worker's disposition tokens — recorded in the SEPARATE resolution_reason
// column (never in failure_reason). Bounded vocabulary; distinct from the entry
// cause so the queue records BOTH why the row entered and what the worker did.
export const RECONCILIATION_DISPOSITION = {
  // RE_EVALUABLE re-attempt executed the governed transition.
  RESOLVED_REEVALUATED: 'RESOLVED_REEVALUATED',
  // SUPERSEDED — a newer observation already applied; resolved with no mutation.
  RESOLVED_SUPERSEDED: 'RESOLVED_SUPERSEDED',
  // INTERVENTION class exhausted its bounded attempts — parked for a human.
  PARKED_INTERVENTION: 'PARKED_INTERVENTION',
  // A null/unresolved external identity is structurally non-replayable — parked
  // (NEVER guessed) once bounded attempts are exhausted.
  PARKED_NON_REPLAYABLE: 'PARKED_NON_REPLAYABLE',
  // A RE_EVALUABLE row that kept refusing (CAS race / still-unmappable) or failed
  // transiently past the attempt cap — parked as poison.
  PARKED_POISON: 'PARKED_POISON',
} as const;

export type ReconciliationDisposition =
  (typeof RECONCILIATION_DISPOSITION)[keyof typeof RECONCILIATION_DISPOSITION];

// The worker's status tokens. status stays a bare String in the DB; this is the
// worker-owned token set (pending is written by the D1 writers).
export const RECONCILIATION_STATUS = {
  PENDING: 'pending',
  RESOLVED: 'resolved',
  PARKED: 'parked',
} as const;

export type ReconciliationStatus =
  (typeof RECONCILIATION_STATUS)[keyof typeof RECONCILIATION_STATUS];
