// Hand-mirrored from the guarded pre-start-requirement HTTP surface
// (apps/api/src/pre-start-requirement/pre-start-requirement.controller.ts —
// listForPlacement) + the value space in libs/pre-start-requirement/src/lib/
// pre-start-requirement-vocab.ts. ats-web cannot import @aramo/pre-start-
// requirement (a forbidden domain edge — ADR-0029), so the READ shape is
// hand-mirrored; keep it 1:1 with the BE. This surface is read-only from the
// requisition workspace — the governed status/waive/ready actions
// (pre_start_requirement:act) execute in the owning pre-start surface, never
// here.

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
