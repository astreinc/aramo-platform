// Hand-mirrored from libs/requisition/src/lib/dto/requisition.view.ts and
// libs/requisition/src/lib/dto/requisition-status.ts. Source-annotated so
// a future BE shape change is caught by the failing build (the missing
// field) — not by silent drift at runtime. R1 hand-mirrors instead of
// importing @aramo/requisition (a forbidden domain edge from
// apps/ats-web).

// T1-d — the RecruitingStatus declared lifecycle. MUST stay 1:1 with the BE
// source libs/requisition/src/lib/dto/requisition-status.ts (RECRUITING_STATUS_
// VALUES / GATED_RECRUITING_STATUS_VALUES); the recruiting-status-drift.spec.ts
// reads that BE source and fails on any divergence (the PipelineStatus mirror +
// drift-guard precedent). Former `active` -> `open`, former `full` ->
// `submittals_closed`; `lead` retained as the functional intake state.
export const RECRUITING_STATUS_VALUES = [
  'lead',
  'draft',
  'pending_approval',
  'open',
  'on_hold',
  'submittals_closed',
  'canceled',
  'closed',
  'archived',
] as const;
export type RecruitingStatus = (typeof RECRUITING_STATUS_VALUES)[number];

// Subsystem-gated values: their behaviour does not exist yet, so a recruiter
// cannot transition INTO them — excluded from the selectable set below (no
// filter chip, no select option). The Approval sub-workflow un-gated `draft` +
// `pending_approval` (now selectable, driving the SUBMIT_FOR_APPROVAL / APPROVE
// / REJECT governed transitions); `archived` stays gated until retention ships.
// MUST stay 1:1 with the BE GATED_RECRUITING_STATUS_VALUES (drift-guarded).
export const GATED_RECRUITING_STATUS_VALUES: readonly RecruitingStatus[] = [
  'archived',
];

// The values a recruiter may actually select / filter on today.
export const SELECTABLE_RECRUITING_STATUS_VALUES: readonly RecruitingStatus[] =
  RECRUITING_STATUS_VALUES.filter(
    (v) => !(GATED_RECRUITING_STATUS_VALUES as readonly string[]).includes(v),
  );

// Q6 ruling — the ONE canonical status→label map. Every surface (list, detail,
// dashboard rollup) consumes THIS; the prior 4-way copy drift (Active/Open,
// Lead/Intake) was the defect T1-d closes. `lead` renders "Lead" (a state), NOT
// "Intake" (a meeting).
export const RECRUITING_STATUS_LABELS: Record<RecruitingStatus, string> = {
  lead: 'Lead',
  draft: 'Draft',
  pending_approval: 'Pending approval',
  open: 'Open',
  on_hold: 'On hold',
  submittals_closed: 'Submittals closed',
  canceled: 'Canceled',
  closed: 'Closed',
  archived: 'Archived',
};

// Q2 ruling — the "my open reqs" framing. Closed = the former `full`
// (submittals_closed) + closed + canceled + the terminal archived. Open =
// everything else (open + lead + on_hold — work the recruiter can still touch).
export const CLOSED_REQUISITION_STATUSES: readonly RecruitingStatus[] = [
  'submittals_closed',
  'closed',
  'canceled',
  'archived',
];

export function isClosedStatus(status: RecruitingStatus): boolean {
  return (CLOSED_REQUISITION_STATUSES as readonly string[]).includes(status);
}

// RequisitionView — mirrors the BE DTO. Compensation fields are present
// in the type (so a future expansion stays type-safe) but are masked at
// the BE for the recruiter (no compensation:view:* scope); R1 does NOT
// render them.
export interface RequisitionView {
  readonly id: string;
  readonly tenant_id: string;
  readonly site_id: string | null;
  readonly title: string;
  // PR-15 — per-tenant internal number; rendered as REQ-{number} (prefix is
  // presentation-only, never stored). Immutable.
  readonly requisition_number: number;
  readonly company_id: string;
  readonly contact_id: string | null;
  readonly company_department_id: string | null;
  readonly status: RecruitingStatus;
  readonly type: string | null;
  readonly duration: string | null;
  readonly description: string | null;
  readonly notes: string | null;
  readonly is_hot: boolean;
  readonly openings: number;
  readonly openings_available: number;
  // Signed capacity balance = openings − active placement consumption. Unlike
  // openings_available (clamped at 0), the sign distinguishes Fully consumed
  // (== 0) from Over capacity (< 0). Placement-derived; hand-mirrors the backend
  // RequisitionView (libs/requisition/src/lib/dto/requisition.view.ts).
  readonly capacity_balance: number;
  // L8-B2 — authoritative requisition-grain Client Status (SubmittalEligibility truth):
  // may another client submittal be sent? `null` ⇒ OPEN (rendered as Open, never Unknown).
  readonly client_submittal_status: 'open' | 'paused' | 'closed' | null;
  readonly client_submittal_reason:
    | 'deadline_passed'
    | 'limit_reached'
    | 'manual_hold'
    | 'paused'
    | null;
  readonly start_date: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly recruiter_id: string | null;
  readonly owner_id: string | null;
  readonly entered_by_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  // Track 1 T1-e (§2.1) — the optimistic-concurrency token, surfaced on the read
  // view so the client can read-then-write. MANDATORY on a status-changing PATCH
  // (§2.4): saveField sends it back when the edited field is status.
  readonly version: number;
  // Compensation surface (BE-masked for recruiter — present here so the
  // type system catches a future un-mask).
  readonly compensation_model: string | null;
  readonly pay_rate_amount: string | null;
  readonly pay_rate_currency: string | null;
  readonly pay_rate_period: string | null;
  readonly bill_rate_amount: string | null;
  readonly bill_rate_currency: string | null;
  readonly bill_rate_period: string | null;
  readonly placement_fee_percent: string | null;
  readonly placement_fee_amount: string | null;
  readonly salary_amount: string | null;
  readonly salary_currency: string | null;
  readonly margin_amount: string | null;
  readonly markup_percent: string | null;
  readonly margin_percent: string | null;

  // --- Job-Module enterprise fields (additive, UN-gated). ---
  readonly job_type: string | null;
  readonly labor_category: string | null;
  readonly role_family: string | null;
  readonly seniority_level: string | null;
  readonly headcount_reason: string | null;
  readonly work_arrangement: string | null;
  // PR-17 — hybrid onsite frequency; null unless work_arrangement = 'hybrid'.
  readonly onsite_days_per_week: number | null;
  readonly travel_percent: number | null;
  readonly relocation_offered: boolean | null;
  readonly work_authorization: string | null;
  readonly end_date: string | null;
  readonly duration_value: number | null;
  readonly duration_unit: string | null;
  readonly extension_possible: boolean | null;
  readonly hours_per_week: number | null;
  readonly source_system: string | null;
  readonly external_req_id: string | null;
  readonly imported_at: string | null;

  // --- Gated financial-planning fields (requisition:view:financials).
  // BE-masked when the actor lacks the scope — present here so the type
  // stays honest and a future un-mask is type-safe. ---
  readonly target_margin_percent: string | null;
  readonly markup_percent_target: string | null;
  readonly rate_card_id: string | null;
  readonly min_bill_rate: string | null;
  readonly max_bill_rate: string | null;
  readonly min_pay_rate: string | null;
  readonly max_pay_rate: string | null;

  // --- Requisition Record Spec Amendment v1.0 (additive, UN-gated). ---
  readonly rate_type: string | null;
  readonly allow_subcontractors: boolean;
  readonly run_match_on_create: boolean;

  // --- AI golden-profile link (read-only on the form; set by the
  // profile/confirm flow). ---
  readonly golden_profile_id: string | null;

  // --- PR-14 (Track C) — personal bookmark state (this user only) ---
  // PERSONAL: whether the CURRENT user has bookmarked this requisition.
  // Distinct from is_hot (team-wide HOT pill); the star must never toggle
  // is_hot. Never reflects another user's state.
  readonly bookmarked: boolean;
}

// Hand-mirrored from libs/requisition/src/lib/dto/rate-type.ts (RATE_TYPE_
// VALUES). A drift-guard spec asserts this matches the BE allowlist 1:1 —
// the worker-classification closed set (String-not-enum on the BE).
export const RATE_TYPE_VALUES = ['C2C', 'W2', '1099', 'Any'] as const;
export type RateType = (typeof RATE_TYPE_VALUES)[number];

export interface RequisitionListResponse {
  readonly items: readonly RequisitionView[];
}

// R4 — mutate-side hand-mirrors.

// Hand-mirrored from libs/requisition/src/lib/dto/rate-period.ts:6-12.
// Closed list — value-list, no drift spec.
export const RATE_PERIOD_VALUES = [
  'HOURLY',
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'ANNUAL',
] as const;
export type RatePeriod = (typeof RATE_PERIOD_VALUES)[number];

// Hand-mirrored from libs/requisition/src/lib/dto/requisition-compensation-
// model.ts:10-13. Discriminator: CONTRACT uses bill/pay; PERMANENT uses
// placement_fee + structured salary. The BE does NOT enforce per-branch
// field constraints (ruling 2 Option A — the form hides off-branch fields
// + sends only on-branch comp; NO auto-clear on a flip).
export const COMPENSATION_MODEL_VALUES = ['CONTRACT', 'PERMANENT'] as const;
export type CompensationModel = (typeof COMPENSATION_MODEL_VALUES)[number];

// Hand-mirrored from libs/requisition/src/lib/dto/create-requisition-
// request.dto.ts. POST /v1/requisitions body shape.
//
// R4 OMISSIONS (Lead rulings):
// - site_id (ruling 4: no GET /v1/sites; @RequireSiteMatch validates session)
// - openings_available (ruling 3: conceptually derived; A5 automates later)
// - rate_max + salary (ruling 5: pre-Compensation-v1.1 legacy; dropped +
//   the D5 write-leak via this pair is closed by D-AUTHZ-COMP-WRITE-2;
//   the columns persist inertly until PR-2's data-gated drop)
// - type, duration, company_department_id, recruiter_id, owner_id
//   (administrative / out-of-scope for R4 — the form's first cut)
export interface CreateRequisitionRequest {
  readonly title: string;
  readonly company_id: string;
  readonly contact_id?: string;
  readonly status?: RecruitingStatus;
  readonly description?: string;
  readonly notes?: string;
  readonly is_hot?: boolean;
  readonly openings?: number;
  readonly start_date?: string;
  readonly city?: string;
  readonly state?: string;

  // v1.1 §2.3 discriminator
  readonly compensation_model?: CompensationModel;

  // v1.1 §2.1 CONTRACT-side (decimal-as-string per the wire format —
  // see decimal-format.ts)
  readonly pay_rate_amount?: string;
  readonly pay_rate_currency?: string;
  readonly pay_rate_period?: RatePeriod;
  readonly bill_rate_amount?: string;
  readonly bill_rate_currency?: string;
  readonly bill_rate_period?: RatePeriod;

  // v1.1 §2.3 PERMANENT-side
  readonly placement_fee_percent?: string;
  readonly placement_fee_amount?: string;
  readonly salary_amount?: string;
  readonly salary_currency?: string;

  // --- Job-Module enterprise fields (additive, UN-gated). ---
  readonly job_type?: string;
  readonly labor_category?: string;
  readonly role_family?: string;
  readonly seniority_level?: string;
  readonly headcount_reason?: string;
  readonly work_arrangement?: string;
  readonly onsite_days_per_week?: number;
  readonly travel_percent?: number;
  readonly relocation_offered?: boolean;
  readonly work_authorization?: string;
  readonly end_date?: string;
  readonly duration_value?: number;
  readonly duration_unit?: string;
  readonly extension_possible?: boolean;
  readonly hours_per_week?: number;
  readonly source_system?: string;
  readonly external_req_id?: string;
  readonly imported_at?: string;

  // --- Requisition Record Spec Amendment v1.0 (additive, UN-gated). ---
  readonly rate_type?: string;
  readonly allow_subcontractors?: boolean;
  readonly run_match_on_create?: boolean;

  // --- Gated financial-planning fields (requisition:view:financials).
  // The form OMITS these unless the financial section is visible (the D5-
  // defensive omission mirror — a non-holder never submits them). ---
  readonly target_margin_percent?: string;
  readonly markup_percent_target?: string;
  readonly rate_card_id?: string;
  readonly min_bill_rate?: string;
  readonly max_bill_rate?: string;
  readonly min_pay_rate?: string;
  readonly max_pay_rate?: string;
}

// Hand-mirrored from libs/requisition/src/lib/dto/update-requisition-
// request.dto.ts. PATCH /v1/requisitions/:id body shape — TRUE PATCH
// semantics (verified at Gate-5: libs/requisition/src/lib/requisition.
// repository.ts:321-379 builds `data: {}` and only adds keys where
// !== undefined; Prisma's update only touches present keys).
//
//   - omitted (undefined / absent) → column UNCHANGED in DB
//   - explicit null → column NULLED
//
// THE D5-DEFENSIVE RULE (ruling 1): a recruiter without compensation:
// view:* MUST OMIT comp fields entirely from the PATCH (never null
// them — null would BLANK live pay data the writer can't see).
//
// `status` is freely editable (no transition guard); not nullable.
// `site_id` is NOT in UPDATE (CREATE-only / immutable).
export interface UpdateRequisitionRequest {
  // T1-e (§2.4) — the expected row version. MANDATORY when `status` changes
  // (the server refuses a status-changing PATCH without it); optional/additive
  // otherwise, preserving the T1-b posture.
  readonly version?: number;
  readonly title?: string;
  readonly contact_id?: string | null;
  readonly status?: RecruitingStatus;
  readonly description?: string | null;
  readonly notes?: string | null;
  readonly is_hot?: boolean;
  readonly openings?: number;
  readonly start_date?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;

  readonly compensation_model?: CompensationModel | null;

  readonly pay_rate_amount?: string | null;
  readonly pay_rate_currency?: string | null;
  readonly pay_rate_period?: RatePeriod | null;
  readonly bill_rate_amount?: string | null;
  readonly bill_rate_currency?: string | null;
  readonly bill_rate_period?: RatePeriod | null;

  readonly placement_fee_percent?: string | null;
  readonly placement_fee_amount?: string | null;
  readonly salary_amount?: string | null;
  readonly salary_currency?: string | null;

  // --- Job-Module enterprise fields (additive, UN-gated). Nullable on
  // PATCH: empty input → null (explicit clear); else send if changed. ---
  readonly job_type?: string | null;
  readonly labor_category?: string | null;
  readonly role_family?: string | null;
  readonly seniority_level?: string | null;
  readonly headcount_reason?: string | null;
  readonly work_arrangement?: string | null;
  readonly onsite_days_per_week?: number | null;
  readonly travel_percent?: number | null;
  readonly relocation_offered?: boolean | null;
  readonly work_authorization?: string | null;
  readonly end_date?: string | null;
  readonly duration_value?: number | null;
  readonly duration_unit?: string | null;
  readonly extension_possible?: boolean | null;
  readonly hours_per_week?: number | null;
  readonly source_system?: string | null;
  readonly external_req_id?: string | null;
  readonly imported_at?: string | null;

  // --- Requisition Record Spec Amendment v1.0 (additive, UN-gated). ---
  readonly rate_type?: string | null;
  readonly allow_subcontractors?: boolean;
  readonly run_match_on_create?: boolean;

  // --- Gated financial-planning fields (requisition:view:financials).
  // Threaded ONLY when the section is visible (D5-defensive omission). ---
  readonly target_margin_percent?: string | null;
  readonly markup_percent_target?: string | null;
  readonly rate_card_id?: string | null;
  readonly min_bill_rate?: string | null;
  readonly max_bill_rate?: string | null;
  readonly min_pay_rate?: string | null;
  readonly max_pay_rate?: string | null;
}
