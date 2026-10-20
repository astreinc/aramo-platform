// DOC-TEMPLATE-ADMIN-RTR-1 (§29-32) — the dependency-inversion PORT by which the
// (scope:ats) Pipeline gates the `qualified` milestone on an RTR precondition WITHOUT
// importing @aramo/documents / the ATS readiness composition (ADR-0029 Pipeline⊥ATS
// wall). The Pipeline owns the `qualified` transition; the RTR readiness decision is
// ATS/Documents truth, so the concrete guard lives at the apps/api composition root
// and is bound to QUALIFIED_TRANSITION_GUARD @Global — mirroring RESUME_EDITION_READER.
// A STRING token (not the bare interface) avoids the non-strict app.get bare-class
// provider-collision trap.
//
// Talent Lifecycle R1–R5 Implementation Directive v1.2 §4.3–§4.5 (A1 AM-6 §7.5):
//   - The guard runs INSIDE the Pipeline transition transaction, on that transaction's
//     connection, in the global lock order of §2.2 T-2: `beginQualifyInTx` (the SHARED
//     client-submittal-policy lock) is the FIRST statement of the transaction; the Pipeline
//     CAS follows; `assertCanQualifyInTx` (policy resolution at the linearization instant +
//     the executed-RTR row FOR SHARE) runs after it.
//   - The guard is MANDATORY for `qualified`: a process without it bound REFUSES the
//     transition (PIPELINE_QUALIFY_RTR_POLICY_UNRESOLVED, reason rtr_guard_unbound) —
//     it never skips the check.

export const QUALIFIED_TRANSITION_GUARD = 'QUALIFIED_TRANSITION_GUARD';

/** The minimal raw-query surface of the Pipeline interactive transaction. */
export interface QualifiedGuardTx {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/**
 * The resolved RTR policy decision the guard applied (v1.2 §4.6 audit). `source` is the
 * layer that set the effective `rtr_present` (TENANT_DEFAULT / CLIENT_OVERRIDE /
 * REQUISITION_OVERRIDE), `resolved_at` the linearization instant t_L.
 */
export interface QualifiedRtrDecision {
  readonly disposition: 'REQUIRED' | 'NOT_REQUIRED';
  readonly source: string | null;
  readonly scope_ref: string | null;
  readonly version: string | null;
  readonly checksum: string | null;
  readonly composite_version: string | null;
  readonly resolved_at: string;
}

export interface QualifiedTransitionGuardPort {
  // FIRST statement of the qualified transition's transaction: take the SHARED
  // per-tenant client-submittal-policy advisory lock (v1.2 §4.4(d)).
  beginQualifyInTx(tx: QualifiedGuardTx, input: { tenant_id: string }): Promise<void>;

  // After the Pipeline CAS (and the requisition gate), on the SAME transaction: read the
  // linearization instant, resolve the effective RTR requirement at it, and — when
  // REQUIRED — lock the EXECUTED RIGHT_TO_REPRESENT for the EXACT (talent, requisition)
  // FOR SHARE. THROWS PIPELINE_QUALIFY_RTR_POLICY_UNRESOLVED (422) when the requirement is
  // UNRESOLVED and PIPELINE_QUALIFY_REQUIRES_RTR (422) when REQUIRED and absent; returns
  // the applied decision for the in-transaction audit record otherwise.
  assertCanQualifyInTx(
    tx: QualifiedGuardTx,
    input: { tenant_id: string; talent_id: string; requisition_id: string; requestId: string },
  ): Promise<QualifiedRtrDecision>;
}
