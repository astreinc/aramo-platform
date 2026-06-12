import type { RatePeriod } from './rate-period.js';
import type { RequisitionCompensationModel } from './requisition-compensation-model.js';
import type { RequisitionStatus } from './requisition-status.js';

// UpdateRequisitionRequestDto — PATCH /v1/requisitions/:id payload.
// `status` is freely editable here per directive §4 (simple enum, NOT
// a state machine — no canTransition guard).
//
// Compensation-Field Modeling v1.1 §2 — all comp fields are
// nullable-clearable (`T | null`) to follow the existing PATCH
// semantics: omitted → unchanged; explicit `null` → cleared.
export interface UpdateRequisitionRequestDto {
  title?: string;
  contact_id?: string | null;
  company_department_id?: string | null;
  status?: RequisitionStatus;
  type?: string | null;
  duration?: string | null;
  description?: string | null;
  notes?: string | null;
  is_hot?: boolean;
  openings?: number;
  openings_available?: number;
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

  // ---- Gated financial-planning fields (🔒 requisition:edit:financials) -
  target_margin_percent?: string | null;
  markup_percent_target?: string | null;
  rate_card_id?: string | null;
  min_bill_rate?: string | null;
  max_bill_rate?: string | null;
  min_pay_rate?: string | null;
  max_pay_rate?: string | null;
}
