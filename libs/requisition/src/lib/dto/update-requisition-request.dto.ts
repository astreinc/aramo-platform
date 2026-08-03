import type { RatePeriod } from './rate-period.js';
import type { RequisitionCompensationModel } from './requisition-compensation-model.js';
import type { RecruitingStatus } from './requisition-status.js';

// UpdateRequisitionRequestDto — PATCH /v1/requisitions/:id payload.
// `status` is freely editable here per directive §4 (simple enum, NOT
// a state machine — no canTransition guard).
//
// Compensation-Field Modeling v1.1 §2 — all comp fields are
// nullable-clearable (`T | null`) to follow the existing PATCH
// semantics: omitted → unchanged; explicit `null` → cleared.
export interface UpdateRequisitionRequestDto {
  // ---- Optimistic concurrency (Track 1 T1-b, ruling R4) ----------------
  // The caller's expected row version for the compare-and-swap. OPTIONAL and
  // additive: absent → the update is unguarded (last-write-wins, the prior
  // behaviour) but the stored version STILL increments; present → the update
  // path guards on it and a mismatch is a stale write (409
  // REQUISITION_VERSION_CONFLICT). This is a control token, NOT a writable
  // content field — it is never spread into the Prisma update `data` and is
  // NOT nullable-clearable. T1-e makes it MANDATORY for governed transitions;
  // this PR keeps it optional so no existing caller breaks.
  version?: number;

  title?: string;
  contact_id?: string | null;
  company_department_id?: string | null;
  status?: RecruitingStatus;
  type?: string | null;
  duration?: string | null;
  description?: string | null;
  notes?: string | null;
  is_hot?: boolean;
  openings?: number;
  // openings_available is intentionally NOT writable via the API (PR-0b-1).
  // A PATCH carrying it is ignored; the counter is mutated ONLY by pipeline
  // placement transitions.
  start_date?: string | null;
  city?: string | null;
  state?: string | null;
  recruiter_id?: string | null;
  owner_id?: string | null;

  compensation_model?: RequisitionCompensationModel | null;

  pay_rate_amount?: string | null;
  pay_rate_currency?: string | null;
  pay_rate_period?: RatePeriod | null;
  bill_rate_amount?: string | null;
  bill_rate_currency?: string | null;
  bill_rate_period?: RatePeriod | null;

  placement_fee_percent?: string | null;
  placement_fee_amount?: string | null;
  salary_amount?: string | null;
  salary_currency?: string | null;

  // ---- Job-Module enterprise fields (§1 Part 1, additive, UN-gated) ----
  // Nullable-clearable PATCH semantics (omitted → unchanged; null → clear).
  job_type?: string | null;
  labor_category?: string | null;
  role_family?: string | null;
  seniority_level?: string | null;
  headcount_reason?: string | null;
  work_arrangement?: string | null;
  // PR-17 — hybrid onsite frequency (1-4; null clears). Server rejects a value
  // when the effective work_arrangement is not 'hybrid', and any value outside
  // 1-4; and NULLS it automatically when work_arrangement changes away from
  // 'hybrid' (even if this field is not in the PATCH).
  onsite_days_per_week?: number | null;
  travel_percent?: number | null;
  relocation_offered?: boolean;
  work_authorization?: string | null;
  end_date?: string | null;
  duration_value?: number | null;
  duration_unit?: string | null;
  extension_possible?: boolean;
  hours_per_week?: number | null;
  source_system?: string | null;
  external_req_id?: string | null;
  imported_at?: string | null;

  // ---- Requisition Record Spec Amendment v1.0 (additive, UN-gated) -----
  rate_type?: string | null;
  allow_subcontractors?: boolean;
  run_match_on_create?: boolean;

  // ---- SRC-2 R3 — publish surface (additive, UN-gated authored statements) ----
  // Editable under ordinary requisition:edit (the status-only gate blocks a
  // status-only editor). NOT comp/financials — never derived from a gated field.
  public_listing?: boolean;
  advertised_pay_min?: string | null;
  advertised_pay_max?: string | null;
  advertised_pay_period?: RatePeriod | null;
  advertised_pay_currency?: string | null;

  // ---- Gated financial-planning fields (🔒 requisition:edit:financials) -
  target_margin_percent?: string | null;
  markup_percent_target?: string | null;
  rate_card_id?: string | null;
  min_bill_rate?: string | null;
  max_bill_rate?: string | null;
  min_pay_rate?: string | null;
  max_pay_rate?: string | null;
}
