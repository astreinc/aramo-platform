// Hand-mirrored from libs/requisition/src/lib/dto/requisition.view.ts and
// libs/requisition/src/lib/dto/requisition-status.ts. Source-annotated so
// a future BE shape change is caught by the failing build (the missing
// field) — not by silent drift at runtime. R1 hand-mirrors instead of
// importing @aramo/requisition (a forbidden domain edge from
// apps/recruiter-console).

export const REQUISITION_STATUS_VALUES = [
  'active',
  'on_hold',
  'full',
  'closed',
  'canceled',
  'lead',
] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUS_VALUES)[number];

// Q2 ruling — the "my open reqs" framing. Closed = filled/closed/canceled.
// Active = everything else (active + lead + on_hold — work the recruiter
// can still touch).
export const CLOSED_REQUISITION_STATUSES: readonly RequisitionStatus[] = [
  'full',
  'closed',
  'canceled',
];

export function isClosedStatus(status: RequisitionStatus): boolean {
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
  readonly company_id: string;
  readonly contact_id: string | null;
  readonly company_department_id: string | null;
  readonly status: RequisitionStatus;
  readonly type: string | null;
  readonly duration: string | null;
  readonly description: string | null;
  readonly notes: string | null;
  readonly is_hot: boolean;
  readonly openings: number;
  readonly openings_available: number;
  readonly start_date: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly recruiter_id: string | null;
  readonly owner_id: string | null;
  readonly entered_by_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
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

  // --- AI golden-profile link (read-only on the form; set by the
  // profile/confirm flow). ---
  readonly golden_profile_id: string | null;
}

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
  readonly status?: RequisitionStatus;
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
  readonly title?: string;
  readonly contact_id?: string | null;
  readonly status?: RequisitionStatus;
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
