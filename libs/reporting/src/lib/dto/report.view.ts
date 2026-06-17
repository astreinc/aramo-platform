import type { ActivityView } from '@aramo/activity';
import type { CalendarEventView } from '@aramo/calendar';
import type { PipelineStatus } from '@aramo/pipeline';
import type { RequisitionStatus } from '@aramo/requisition';

// PR-A7 — read-only view DTOs for the ATS-internal reporting surface.
//
// Vocabulary discipline (R12): every metric here is an aggregation over
// the ATS-side schemas (company / contact / requisition / pipeline /
// activity / calendar / saved_list / talent_record). NO Core /
// engagement / submittal / examination read is involved — the
// seam-exclusion is structural. Submittal-derived metrics (e.g. "recent
// hires from confirmed submittals") are NOT computed here; the
// ATS-internal placed-pipeline count is the substitute.

// TenantCountsReportView — total row counts per ATS entity in the
// caller's tenant + site filter. Tenant-wide for both recruiter and
// tenant_admin (the A3 role-visibility predicate does NOT apply to
// reference-entity counts — only the requisition / pipeline rollups
// gate on the assignment visibility).
export interface TenantCountsReportView {
  companies: number;
  contacts: number;
  talent_records: number;
  saved_lists: number;
  calendar_events: number;
  activities: number;
}

// RequisitionStatusRollupView — per-RequisitionStatus bucket map for
// the caller's visibility set. Recruiter sees only assigned reqs
// (`requisition:read:all` absent → assignments-some predicate);
// tenant_admin sees tenant-wide.
export interface RequisitionStatusRollupView {
  total: number;
  by_status: Array<{ status: RequisitionStatus; count: number }>;
}

// PipelineStageRollupView — per-PipelineStatus bucket map for the
// caller's visible-requisition set (the A3 predicate applied upstream:
// recruiter sees pipelines on their assigned reqs only; tenant_admin
// sees tenant-wide).
export interface PipelineStageRollupView {
  total: number;
  by_status: Array<{ status: PipelineStatus; count: number }>;
}

// PlacementCountReportView — the ATS-internal placement count = number
// of pipelines in `placed` status within the caller's visible set.
// This is the A5b-1-derived view (placement is the pipeline terminal
// state with the openings_available decrement). NOT the Core
// submittal-placement count (that lives behind the engagement schema
// seam, no ATS read path; see T5 / M6).
export interface PlacementCountReportView {
  placed_pipelines: number;
  // Documented seam — the field is informational only, fixed false
  // until the T5 ATS-facing submittal read path lands.
  includes_core_submittal_placements: false;
}

// CompanyMetricsView — per-company ATS operational rollup for the companies
// surface (list columns / drawer / account-hub KPI strip). Composed across
// company→requisition→pipeline via the cross-schema id-list pattern, scoped by
// the actor's visibility. `active_placements` is the placed-pipeline count (the
// A5b-1 terminal state — NOT a Core submittal placement). `fill_rate` is
// requisition-derived (filled / openings), null when the company has no
// openings. NO revenue here (no billing ledger; the FE shows the firmographic
// annual_revenue_band instead).
export interface CompanyMetricsView {
  company_id: string;
  open_reqs: number; // status active|on_hold
  active_placements: number; // pipeline placed
  submitted: number; // pipeline submitted|interviewing|offered
  openings: number; // sum of req openings
  filled: number; // sum of (openings - openings_available)
  fill_rate: number | null; // percent 0-100, null when openings === 0
}

export interface CompanyMetricsReportView {
  items: CompanyMetricsView[];
}

// DashboardView — the composition payload for GET /v1/dashboard.
// Bundles the ATS-internal metrics into a single response so a
// recruiter UI doesn't have to N-round-trip on load.
export interface DashboardView {
  tenant_counts: TenantCountsReportView;
  requisition_rollup: RequisitionStatusRollupView;
  pipeline_rollup: PipelineStageRollupView;
  placement: PlacementCountReportView;
  upcoming_events: CalendarEventView[];
  recent_activity: ActivityView[];
}
