// T1-a (Track 1 Directive §2, L1) — ports-and-adapters inversion for the
// requisition lifecycle state the Live List + match-list depend on.
//
// libs/examination is scope:cip and MUST NOT import scope:ats (the
// Pipeline⊥ATS wall, ADR-0029/I15), so it cannot read requisition.Requisition
// directly. It DECLARES the narrow interface it needs; apps/api (untagged
// composition root) provides the adapter backed by RequisitionRepository. The
// dependency inverts and the wall holds by construction — the same pattern the
// auth-decoupling arc shipped (libs/auth-core EligibilityPolicy →
// apps/auth-service adapter).
//
// The Live List genuinely needs exactly ONE fact: is the requisition an ACTIVE
// requisition in this tenant? Under the Gate-1 T1 shared-UUID alignment (the
// ATS requisition id == GoldenProfile.job_id == examination.job_id == R), the
// match-list's {job_id} path value IS the requisition id, so
// isActive(tenant_id, requisition_id) is the whole port — no fields returned,
// no join. This replaces the retired job_domain.Requisition mirror, whose
// `state` was written once as 'active' and never updated (the live defect: a
// requisition closed in the ATS still read active through the mirror).

export const REQUISITION_STATE_READER = 'REQUISITION_STATE_READER';

export interface RequisitionStateReader {
  // True iff a requisition with this id exists in the tenant AND is in an
  // active recruiting state. False for a missing, cross-tenant, or non-active
  // (closed / on_hold / full / canceled / lead) requisition.
  isActive(tenant_id: string, requisition_id: string): Promise<boolean>;
}
