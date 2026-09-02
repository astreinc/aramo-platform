// Hand-mirrored from the guarded pre-start-requirement HTTP surface
// (apps/api/src/pre-start-requirement/pre-start-requirement.controller.ts —
// listForPlacement) + the value space in libs/pre-start-requirement/src/lib/
// pre-start-requirement-vocab.ts. ats-web cannot import @aramo/pre-start-
// requirement (a forbidden domain edge — ADR-0029), so the shapes are
// hand-mirrored; keep them 1:1 with the BE. L5-P7: this pre-start module is now the
// OWNING onboarding surface — the governed act/verify/waive/reopen/ready actions
// execute here (the requisition workspace Pre-Start tab remains read-only and links
// here). Read + write shapes are both hand-mirrored.

export const REQUIREMENT_STATUS_VALUES = [
  'PENDING',
  'IN_PROGRESS',
  'SATISFIED',
  'FAILED',
  'WAIVED',
  'CANCELED',
] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUS_VALUES)[number];

export const REQUIREMENT_STATUS_LABELS: Record<RequirementStatus, string> = {
  PENDING: 'Pending',
  IN_PROGRESS: 'In progress',
  SATISFIED: 'Satisfied',
  FAILED: 'Failed',
  WAIVED: 'Waived',
  CANCELED: 'Canceled',
};

// L5-P6 — the requirement's satisfaction policy (hand-mirrored from the BE vocab).
export const SATISFACTION_POLICY_VALUES = ['SELF_ATTEST', 'VERIFICATION_REQUIRED'] as const;
export type SatisfactionPolicy = (typeof SATISFACTION_POLICY_VALUES)[number];

// Waiver authority classes (hand-mirrored from WAIVER_AUTHORITY_VALUES).
export const WAIVER_AUTHORITY_VALUES = ['CLIENT', 'COMPLIANCE', 'INTERNAL'] as const;
export type WaiverAuthority = (typeof WAIVER_AUTHORITY_VALUES)[number];

// A single requirement instance. evidence_reference is redacted server-side
// unless the caller holds pre_start_requirement:read_restricted_evidence
// (evidence_restricted reflects that redaction). completed_at/created_at/
// updated_at are Dates on the BE; over JSON they arrive as ISO strings.
export interface PreStartRequirementView {
  readonly id: string;
  readonly placement_process_id: string;
  readonly requirement_type: string;
  readonly label: string;
  readonly blocking: boolean;
  readonly owner_role: string | null;
  // L5-P6 — SELF_ATTEST requirements satisfy via the act path; VERIFICATION_REQUIRED
  // requirements need the governed verify action (a distinct verifier). Hand-mirrored
  // from InstanceView.satisfaction_policy.
  readonly satisfaction_policy: SatisfactionPolicy;
  readonly status: RequirementStatus;
  readonly completed_at: string | null;
  readonly completed_by: string | null;
  readonly evidence_reference: string | null;
  readonly evidence_restricted: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

// GET /v1/pre-start-requirement/placements/:placementId/requirements response.
// `ready` + `blocking_unresolved_count` are BE-derived over the blocking
// assessment; `materialized` is false when the placement has no requirement set
// yet. The client renders these verbatim and never re-derives readiness.
export interface PreStartPlacementRequirements {
  readonly materialized: boolean;
  readonly ready: boolean;
  readonly blocking_unresolved_count: number;
  readonly requirements: readonly PreStartRequirementView[];
}

// ---- L5-P7 — governed-action request shapes (this IS the owning surface) --------
// Hand-mirrored from the guarded write DTOs (StatusMoveDto / VerifyDto / WaiveDto /
// ReopenDto). The BE scope guards (pre_start_requirement:act / :verify / :waive_* /
// :reopen) + the domain floors are the authority; these are thin request bodies.

// A non-waiver status move (SATISFIED for SELF_ATTEST, FAILED, IN_PROGRESS).
export interface StatusMoveRequest {
  readonly to: RequirementStatus;
  readonly reason?: string;
  readonly justification?: string;
  readonly source?: string;
  readonly evidence_reference?: string;
}
// Governed verification of a VERIFICATION_REQUIRED requirement (distinct verifier).
export interface VerifyRequest {
  readonly justification?: string;
  readonly source?: string;
  readonly evidence_reference?: string;
}
export interface WaiveRequest {
  readonly authority: WaiverAuthority;
  readonly justification: string;
  readonly source?: string;
  readonly evidence_reference?: string;
}
export interface ReopenRequest {
  readonly justification: string;
  readonly source?: string;
}
