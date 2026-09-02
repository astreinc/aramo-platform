import type { ActivityView } from '@aramo/activity';
import type { CalendarEventView } from '@aramo/calendar';
import type { PipelineStatus } from '@aramo/pipeline';
import type { RecruitingStatus } from '@aramo/requisition';

// PR-A7 — read-only view DTOs for the ATS-internal reporting surface.
//
// Vocabulary discipline (R12): every metric here is an aggregation over
// the ATS-side schemas (company / contact / requisition / pipeline /
// activity / calendar / saved_list / talent_record). NO Core /
// selection / submittal / examination read is involved — the
// seam-exclusion is structural. Submittal-derived metrics (e.g. "recent
// hires from confirmed submittals") are NOT computed here; the
// ATS-internal established-placement count is the substitute.

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

// RequisitionStatusRollupView — per-RecruitingStatus bucket map for
// the caller's visibility set. Recruiter sees only assigned reqs
// (`requisition:read:all` absent → assignments-some predicate);
// tenant_admin sees tenant-wide.
export interface RequisitionStatusRollupView {
  total: number;
  by_status: Array<{ status: RecruitingStatus; count: number }>;
}

// PipelineStageRollupView — per-PipelineStatus bucket map for the
// caller's visible-requisition set (the A3 predicate applied upstream:
// recruiter sees pipelines on their assigned reqs only; tenant_admin
// sees tenant-wide).
export interface PipelineStageRollupView {
  total: number;
  by_status: Array<{ status: PipelineStatus; count: number }>;
}

// PlacementCountReportView — the ATS-internal placement count = distinct (talent,
// requisition) with an *established* PlacementProcess (canonical fill, L2-G) within the
// caller's visible set. NOT the Core submittal-placement count (that lives behind the
// selection schema seam, no ATS read path; see T5 / M6).
// Provenance of the fill authority a reporting figure derives from.
export type CanonicalFillSource = 'PLACEMENT_PROCESS';

export interface PlacementCountReportView {
  // L2-G — now the count of DISTINCT (talent, requisition) with an *established*
  // PlacementProcess (canonical fill, D-1). Field name preserved for contract stability;
  // provenance is stamped in `canonical_fill_source`.
  placed_pipelines: number;
  // Documented seam — the field is informational only, fixed false
  // until the T5 ATS-facing submittal read path lands.
  includes_core_submittal_placements: false;
  canonical_fill_source?: CanonicalFillSource;
}

// CompanyMetricsView — per-company ATS operational rollup for the companies
// surface (list columns / drawer / account-hub KPI strip). Composed across
// company→requisition→pipeline via the cross-schema id-list pattern, scoped by
// the actor's visibility. `active_placements` is the established-placement count
// (distinct (talent, req) PlacementProcess, L2-G — NOT a Core submittal placement). `fill_rate` is
// requisition-derived (filled / openings), null when the company has no
// openings. NO revenue here (no billing ledger; the FE shows the firmographic
// annual_revenue_band instead).
export interface CompanyMetricsView {
  company_id: string;
  open_reqs: number; // status active|on_hold
  active_placements: number; // distinct (talent, req) established PlacementProcess (L2-G)
  // NOT-PRODUCTION-AUTHORITATIVE: distinct (talent, req) first-Submittal grains, sourced
  // Submittal-only (Legacy-Pipeline-Canonicalization removed the Pipeline band read; no
  // interview/offer contribution is reconstructed pending Submittal/Offer reporting).
  submitted: number;
  openings: number; // sum of req openings
  filled: number; // sum of (openings - openings_available)
  fill_rate: number | null; // percent 0-100, null when openings === 0
}

export interface CompanyMetricsReportView {
  items: CompanyMetricsView[];
}

// CompanyPlacementView — a canonical placement (PlacementProcess established, D-1) at
// one of the company's reqs (the account-hub Placements tab). Talent display name is
// resolved client-side. Lane 2 / L2-G — re-based onto the placement spine: identity is
// now `placement_process_id` (the first-established placement per (talent, req)); the
// legacy `pipeline_id` is OPTIONAL (the placement spine has no pipeline id) and omitted.
export interface CompanyPlacementView {
  placement_process_id: string;
  // Deprecated (L2-G) — the placement spine carries no pipeline id; retained OPTIONAL for
  // consumers reading legacy responses. New responses omit it.
  pipeline_id?: string;
  talent_record_id: string;
  requisition_id: string;
  requisition_title: string;
}

export interface CompanyPlacementsReportView {
  items: CompanyPlacementView[];
}

// RecruiterMetricsView — the principal-scoped operational KPIs for the My Desk
// header (GET /v1/reports/recruiter-metrics). Each metric is computed over the
// caller's VISIBLE requisitions (the same A3/D4b assignment predicate the other
// rollups use — "my" desk), from pipeline status-history transitions:
//   - submittals_weekly   : first Submittal (Submittal-owned) in the last 7 days
//   - placements_monthly  : established PlacementProcess this calendar month
//   - avg_time_to_submit  : mean days from pipeline-create → first Submittal,
//                           over the submittals in the last 7 days
// Legacy-Pipeline-Canonicalization — the `interviews_weekly` KPI is REMOVED with the
// retired Pipeline interview stage; interview volume is a Client-Selection
// (InterviewSession) fact and is NOT reconstructed here. An interview metric is rebuilt
// from its authoritative owner when recruiter reporting is made production-ready.
export type RecruiterMetricKey =
  | 'submittals_weekly'
  | 'placements_monthly'
  | 'avg_time_to_submit';

export interface RecruiterMetricView {
  key: RecruiterMetricKey;
  // Current-period value. Counts are integers; avg_time_to_submit is days
  // (1 decimal). null only for avg_time_to_submit when the window is empty.
  value: number | null;
  // Prior comparable period (for the delta); null when not computable.
  previous: number | null;
  // Per-period series oldest→newest for the sparkline.
  series: number[];
  // Tenant-default target for the period; null when no goal is configured.
  goal: number | null;
  // Period unit (honest "· wk" / "· MTD" labels; no fabricated window).
  period: 'week' | 'month';
}

export interface RecruiterMetricsReportView {
  items: RecruiterMetricView[];
}

// FillPerformanceReportView — T9-B1 authoritative fill-rate + time-to-fill
// operational report (GET /v1/reports/fill-performance). Governed by
// Aramo-T9-B1-Directive-v1_0-LOCKED + Gate5-Finalization-Amendment.
//
// Cohort: requisitions whose `created_at ∈ [period.from, period.to)`
// (amendment D-3), visibility/tenant/site/A3-scoped. `canceled`
// requisitions are excluded from BOTH numerator and denominator (§4).
//
// Fill authority is the established PlacementProcess (L2-G, D-1) — NOT the
// rejected capacity-derived `openings - openings_available` and NOT
// ACTIVE ContractAssignment. Per requisition:
//   filled_openings(req) = min(distinct established-placement talents, openings)
// Aggregate:
//   fill_rate = round( Σ filled_openings / Σ openings * 100 )  (percent
//   0-100, integer — mirrors CompanyMetricsView.fill_rate convention),
//   null when Σ openings === 0.
//
// Time-to-fill (D-2 / §5): start = Requisition.created_at (REOPEN never
// restarts, §7); end = the Nth distinct talent's FIRST established
// PlacementProcess (established instant), N = openings — i.e.
// the "last required opening filled" instant. ONLY fully-filled
// requisitions contribute; partial/open/closed-unfilled have no TTF
// (§6). No survival/censor statistic. `average_days` is the mean over
// the contributing requisitions (1 decimal), null when count === 0.
// L2-G — Time-to-Fill is now opened→established (canonical fill = PlacementProcess
// established, D-1); `canonical_fill_source` stamps the provenance.
export interface FillPerformanceReportView {
  canonical_fill_source?: CanonicalFillSource;
  period: {
    from: string; // ISO absolute instant (UTC-normalized), inclusive
    to: string; // ISO absolute instant (UTC-normalized), exclusive
  };
  openings: number; // Σ requisition.openings over the (non-canceled) cohort
  filled_openings: number; // Σ min(distinct established-placement talents, openings)
  fill_rate: number | null; // percent 0-100, null when openings === 0
  fully_filled_requisitions: number; // cohort reqs with distinct placed ≥ openings
  time_to_fill: {
    count: number; // # fully-filled reqs contributing a TTF value
    average_days: number | null; // mean days created_at→Nth-placed, null when count === 0
  };
}

// SourceEffectivenessReportView — L2-I (D3). A GP-1-safe source→outcome CORRELATION read:
// per L2-D source origin, CLASSIFIED EVIDENCE (counts + canonical reasons + rates), NEVER an
// ordinal quality output (ADR-0019 / Rule C) and NEVER a Talent-trust write (GP-1). It correlates
// the recruiting outcome (current canonical Pipeline status distribution + disposition reasons)
// with the canonical hiring outcome (PlacementProcess established, D-1); provenance is the
// source origin + `canonical_fill_source`.
export interface SourceEffectivenessRow {
  readonly source_origin_type: string; // the L2-D origin (e.g. JOB_BOARD / VMS / EXTERNAL_ATS)
  readonly episodes: number; // distinct episodes attributed to this source
  readonly by_status: ReadonlyArray<{ status: string; count: number }>; // current-status distribution
  readonly dispositioned_by_reason: ReadonlyArray<{ reason: string; count: number }>; // canonical reason buckets
  readonly established_placements: number; // episodes whose (req,talent) reached PlacementProcess established
  readonly fill_rate: number; // percent 0-100 = established / episodes (evidence, not a verdict)
}
export interface SourceEffectivenessReportView {
  readonly canonical_fill_source: CanonicalFillSource;
  readonly sources: ReadonlyArray<SourceEffectivenessRow>;
}

// RecruitingFunnelReportView — L2-I (D4). The RECRUITING funnel — Pipeline-OWNED stages only,
// projected from the canonical L2-C PipelineStatus registry (Rule D; Lane2-DDR §4). It carries
// NO hiring stage (submitted/interview/offer/accepted/placement/start are downstream-owned) —
// the two families are separate returned shapes on separate routes and never collapse each other.
export type RecruitingFunnelStage =
  | 'considered'
  | 'contacted'
  | 'responded'
  | 'qualifying'
  | 'qualified'
  | 'dispositioned';
export interface RecruitingFunnelReportView {
  readonly canonical_source: 'PIPELINE';
  readonly stages: ReadonlyArray<{ stage: RecruitingFunnelStage; count: number }>;
}

// HiringFunnelReportView — L2-I (D4). The HIRING funnel — DOWNSTREAM-owner-attributed stages,
// each sourced from its OWNING aggregate (Submittal / Client-Selection / Offer / Placement),
// composed at the apps/api owner-projection boundary (the A7 seam keeps Submittal + Client-
// Selection out of libs/reporting). It carries NO recruiter-consideration stage.
export type HiringFunnelStage =
  | 'submitted'
  | 'interview'
  | 'offer'
  | 'accepted'
  | 'placement'
  | 'start';
export interface HiringFunnelReportView {
  readonly stages: ReadonlyArray<{ stage: HiringFunnelStage; owner: string; count: number }>;
}

// FallthroughReportView — T9-B2 authoritative fallthrough-rate + reasons report
// (GET /v1/reports/fallthrough). Governed by Aramo-T9-B2-Directive-v1_0-LOCKED.
//
// Placement-attempt level, post-acceptance/pre-start ONLY. Cohort =
// PlacementProcess attempts ESTABLISHED (born at PRE_START = created_at) ∈
// [period.from, period.to) (D-2/D-4), scoped to the actor's A3-visible
// requisitions. L4-0: acceptance lives in the Offer aggregate and a placement
// is created only downstream of an accepted offer, so establishment IS the
// accepted cohort. `fallthrough_attempts` = those that later terminate in
// FELL_THROUGH or NO_SHOW ONLY (D-1); STARTED and still-live are excluded.
// `fallthrough_rate` = round(fallthrough / accepted * 100) integer percent
// (B1 convention), null when accepted_attempts === 0.
//
// `reasons` groups the fallthrough terminals by the canonical placement reason
// (`reason_code` + `reason_label_snapshot` → `reason_label`); a terminal with no
// persisted reason is grouped into a REPORT-ONLY `{ reason_code: null,
// reason_label: "Unspecified" }` bucket (D-8) — never written back. `reason_detail`
// (PII) is NEVER read, aggregated, or exposed (§16).
export interface FallthroughReasonView {
  reason_code: string | null;
  reason_label: string; // reason_label_snapshot, or "Unspecified" for the null bucket
  count: number;
  rate: number; // percent 0-100 of fallthrough_attempts represented by this bucket
}

export interface FallthroughReportView {
  period: { from: string; to: string };
  accepted_attempts: number; // denominator
  fallthrough_attempts: number; // numerator
  fallthrough_rate: number | null; // percent 0-100, null when accepted_attempts === 0
  reasons: FallthroughReasonView[];
}

// AssignmentPipelineReportView — T9-B3 assignment-pipeline operational view
// (GET /v1/reports/assignment-pipeline). Governed by
// Aramo-T9-B3-Directive-v1_0-LOCKED. CURRENT-SNAPSHOT, counts-only.
//
// The authoritative spine is `PlacementProcess.state` (COMPLETE). `by_state`
// carries the FOUR live states in fixed lifecycle order — PRE_START, BLOCKED,
// READY_TO_START, STARTED — always present (zero-filled); the terminal losses
// (NO_SHOW, FELL_THROUGH) are excluded (§3). L4-0 collapsed OFFER_* out — a
// placement is born at PRE_START. `total_live` is the sum of exactly those four
// counts (§10); the `contract_assignments` block does NOT contribute to it.
//
// `start_date` buckets the four pre-start states by `proposed_start_date` on a
// UTC calendar (no tenant timezone exists); NULL → `unspecified` (§8); STARTED
// is excluded. `contract_assignments` is BOUNDED / forward-materialized only —
// `coverage: "forward_materialized"` labels that a STARTED placement may lack a
// ContractAssignment, so STARTED ≠ active + ended (§6). No commercial field, no
// row-level item, no `ended_at` (§5/§11/§20).
export interface AssignmentPipelineStateCount {
  state: string;
  count: number;
}

export interface AssignmentPipelineReportView {
  total_live: number;
  by_state: AssignmentPipelineStateCount[];
  start_date: {
    overdue: number;
    today: number;
    next_7_days: number;
    later: number;
    unspecified: number;
    timezone_basis: 'UTC';
  };
  contract_assignments: {
    active: number;
    ended: number;
    coverage: 'forward_materialized';
  };
}

// GuaranteeExposureReportView — T7-P4 authoritative guarantee-exposure summary. Governed by
// Aramo-T7-P4-Guarantee-Exposure-Reporting-Implementation-Directive-v1_0-LOCKED. Cohort =
// PermanentPlacement.created_at (immutable activation instant) in [from, to). Historical
// exposure is sourced ONLY from the immutable snapshot (guarantee_exposure_amount + currency);
// remedy obligation totals from the immutable PermanentPlacementRemedy facts. Money never
// crosses currencies — monetary values live only in per-currency buckets (scale-2 decimal
// STRINGS, the placement money-at-boundary convention), with NO synthetic global total. All
// counts may be cross-currency. `at_risk` == `active` in P4. remedy_obligation amounts are
// OBLIGATIONS, not payments; REPLACEMENT is count-only. Summary-only: NO row-level ids/PII.
export interface GuaranteeExposureReportView {
  period: {
    from: string; // ISO absolute instant (UTC-normalized), inclusive
    to: string; // ISO absolute instant (UTC-normalized), exclusive
  };
  cohort_count: number; // all authorized PermanentPlacements in [from, to)
  exposure_by_currency: Array<{
    currency: string;
    total: string; // Σ guarantee_exposure_amount over the currency's cohort
    active: string; // Σ where lifecycle_state = GUARANTEE_ACTIVE
    satisfied: string; // Σ where GUARANTEE_SATISFIED
    fell_off: string; // Σ where state in fell-off family
    at_risk: string; // == active in P4 (still within an active guarantee window)
  }>;
  states: {
    active: number;
    satisfied: number;
    fell_off: number; // count of the fell-off family
    remedy_due: {
      replacement: number;
      refund: number;
      prorated_credit: number;
    };
    remedy_completed: number; // evidence completed — NOT payment
  };
  remedy_obligation_by_currency: Array<{
    currency: string;
    refund_total: string; // Σ REFUND obligation amounts (owed, not paid)
    prorated_credit_total: string; // Σ PRORATED_CREDIT obligation amounts (owed, not paid)
  }>;
  falloff_rate: number; // states.fell_off / cohort_count; 0 when cohort_count === 0
}

// MarginReportView — T9-B4 margin operational view (GET /v1/reports/margin).
// Governed by Aramo-T9-B4-Directive-v1_0-LOCKED. CURRENT-SNAPSHOT, AGGREGATE-ONLY.
//
// One row per homogeneous (currency, rate_period) group; `group_margin_percent` is
// the GOVERNED bill-rate-weighted aggregate SUM(bill-pay)/SUM(bill)*100 as a scale-2
// decimal string, or null when the group's bill total is zero (§8 D-5). Group order
// is deterministic — currency ASC, then canonical rate-period order (§13). Coverage
// is FORWARD_MATERIALIZED: `eligible_count = commercialized_count +
// missing_commercial_count` (§6 D-3). The report is aggregate-only: it carries NO
// per-assignment row, NO talent/person id, NO pay/bill/spread/markup amount, NO
// total_spread, NO effective dates, NO ended_at, NO version lineage (§13 D-10).
//
// The aggregate field is `group_margin_percent` (NOT `margin_percent`) per
// Aramo-T9-B4-Margin-Field-Masking-Amendment-v1_0-LOCKED: `margin_percent` is in the
// closed COMPENSATION_FIELD_KEYS catalog and would be deleted by the global D5
// CompensationFieldMaskInterceptor for any actor lacking compensation:view:margin:percent
// — a scope §12 forbids as a B4 gate. The distinct name avoids the collision and
// marks this as a group aggregate, not a row-level compensation field.
export interface MarginGroupView {
  currency: string;
  rate_period: string;
  assignment_count: number;
  group_margin_percent: string | null;
}

export interface MarginReportView {
  eligible_count: number;
  commercialized_count: number;
  missing_commercial_count: number;
  coverage: 'forward_materialized';
  groups: MarginGroupView[];
}

// OnboardingRollupReportView — Lane 5 / L5-P8 onboarding-readiness operational
// view (GET /v1/reports/onboarding-rollup). Governed by
// Aramo-Fulfillment-Onboarding-Readiness-Lane5-Directive-v1_0-LOCKED (Amendment A1,
// option (a)). Tenant-scoped, READ-ONLY aggregate over the first-class pre-start
// facts, PULLED via the reporting→pre-start-requirement edge. It carries NO
// per-instance row, NO placement id, NO evidence pointer, NO actor id — it is an
// aggregate observation surface, never a command surface.
export interface OnboardingRequirementCellView {
  requirement_type: string;
  status: string;
  count: number;
}

export interface OnboardingRollupReportView {
  // Requirement-completion matrix: one cell per (requirement_type, status),
  // deterministically ordered (type ASC, then status ASC).
  by_type_status: OnboardingRequirementCellView[];
  totals: {
    total: number;
    resolved: number; // SATISFIED | WAIVED | CANCELED
    unresolved: number; // PENDING | IN_PROGRESS | FAILED
    blocking_unresolved: number; // the readiness-gap signal
  };
  // Readiness-decision history from the append-only ledger.
  readiness_decisions: {
    ready: number;
    refused: number;
    refused_materialization_absent: number;
    refused_blocking_unresolved: number;
  };
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
