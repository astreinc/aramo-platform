import type { RatePeriod } from './rate-period.js';
import type { RequisitionCompensationModel } from './requisition-compensation-model.js';
import type { RequisitionStatus } from './requisition-status.js';

// CreateRequisitionRequestDto — POST /v1/requisitions payload.
// tenant_id is derived from AuthContext.tenant_id, never the body.
//
// Compensation-Field Modeling v1.1 §2 — the structured comp surface.
// All comp fields optional; the discriminator (compensation_model)
// labels which set is meaningful (CONTRACT → bill/pay; PERMANENT →
// placement_fee + structured salary). Decimal money fields are
// accepted as strings to preserve precision over the wire (the
// repository turns them into Prisma.Decimal at the boundary).
export interface CreateRequisitionRequestDto {
  title: string;
  company_id: string;
  site_id?: string;
  contact_id?: string;
  company_department_id?: string;
  status?: RequisitionStatus;
  type?: string;
  duration?: string;
  description?: string;
  notes?: string;
  is_hot?: boolean;
  openings?: number;
  openings_available?: number;
  start_date?: string;
  city?: string;
  state?: string;
  recruiter_id?: string;
  owner_id?: string;

  // v1.1 §2.3 discriminator.
  compensation_model?: RequisitionCompensationModel;

  // v1.1 §2.1 — the two stored facts (CONTRACT). Money fields are
  // decimal strings ("60.00") — Decimal-safe wire format.
  pay_rate_amount?: string;
  pay_rate_currency?: string;
  pay_rate_period?: RatePeriod;
  bill_rate_amount?: string;
  bill_rate_currency?: string;
  bill_rate_period?: RatePeriod;

  // v1.1 §2.3 — PERMANENT-side fields.
  placement_fee_percent?: string;
  placement_fee_amount?: string;
  salary_amount?: string;
  salary_currency?: string;

  // ---- Job-Module enterprise fields (§1 Part 1, additive, UN-gated) ----
  // String-not-enum closed vocabularies (R7). Numeric fields are numbers;
  // booleans default false at the repository when omitted.
  job_type?: string;
  labor_category?: string;
  role_family?: string;
  seniority_level?: string;
  headcount_reason?: string;
  work_arrangement?: string;
  travel_percent?: number;
  relocation_offered?: boolean;
  work_authorization?: string;
  end_date?: string;
  duration_value?: number;
  duration_unit?: string;
  extension_possible?: boolean;
  hours_per_week?: number;
  source_system?: string;
  external_req_id?: string;
  imported_at?: string;

  // ---- Requisition Record Spec Amendment v1.0 (additive, UN-gated) -----
  // rate_type is guarded against the closed allowlist (C2C|W2|1099|Any) at
  // the controller boundary. run_match_on_create is the stored run-match
  // INTENT flag (reserves matching; triggers nothing at create).
  rate_type?: string;
  allow_subcontractors?: boolean;
  run_match_on_create?: boolean;

  // ---- Gated financial-planning fields (🔒 requisition:edit:financials) -
  // LB-4: write-gated by the financial edit-gate at the repository
  // boundary. Decimal money/percent fields are decimal strings (Decimal-
  // safe wire format, like the comp fields). NOT the compensation family.
  target_margin_percent?: string;
  markup_percent_target?: string;
  rate_card_id?: string;
  min_bill_rate?: string;
  max_bill_rate?: string;
  min_pay_rate?: string;
  max_pay_rate?: string;
}
