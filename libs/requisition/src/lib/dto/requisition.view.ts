import type { RatePeriod } from './rate-period.js';
import type { RequisitionCompensationModel } from './requisition-compensation-model.js';
import type { RequisitionStatus } from './requisition-status.js';

// RequisitionView — Compensation-Field Modeling v1.1 §2 + §3.
//
// The structured comp surface has two parts:
//   (a) STORED facts — pay_rate_*, bill_rate_*, placement_fee_*,
//       salary_* (all nullable; their meaningfulness is gated by
//       compensation_model).
//   (b) DERIVED views — margin_amount, markup_percent, margin_percent.
//       NOT stored (§2.2 + §10 halt). Computed-on-read in projectView
//       as Decimal strings. EACH is an independent optional field so
//       D5's per-role mask can include/omit them individually without
//       inversion-leak (§3 reconciliation: any spread view + pay_rate
//       reveals bill_rate, so D5 likely omits ALL spread views when
//       it exposes pay_rate).
//
// All comp fields are nullable on read. The derived views are
// additionally null when bill + pay do not share currency + period
// (§2.2 guard / proof 13).
export interface RequisitionView {
  id: string;
  tenant_id: string;
  site_id: string | null;
  title: string;
  company_id: string;
  contact_id: string | null;
  company_department_id: string | null;
  status: RequisitionStatus;
  type: string | null;
  duration: string | null;
  description: string | null;
  notes: string | null;
  is_hot: boolean;
  openings: number;
  openings_available: number;
  start_date: string | null;
  city: string | null;
  state: string | null;
  recruiter_id: string | null;
  owner_id: string | null;
  entered_by_id: string | null;
  created_at: string;
  updated_at: string;

  // v1.1 §2 — stored facts.
  compensation_model: RequisitionCompensationModel | null;
  pay_rate_amount: string | null;
  pay_rate_currency: string | null;
  pay_rate_period: RatePeriod | null;
  bill_rate_amount: string | null;
  bill_rate_currency: string | null;
  bill_rate_period: RatePeriod | null;
  placement_fee_percent: string | null;
  placement_fee_amount: string | null;
  salary_amount: string | null;
  salary_currency: string | null;

  // v1.1 §2.2 — derived views (computed-on-read, NOT stored).
  // Independently nullable so D5 can per-field mask (§3).
  margin_amount: string | null;
  markup_percent: string | null;
  margin_percent: string | null;

  // ---- Job-Module enterprise fields (§1 Part 1, additive) -------------
  job_type: string | null;
  labor_category: string | null;
  role_family: string | null;
  seniority_level: string | null;
  headcount_reason: string | null;
  work_arrangement: string | null;
  travel_percent: number | null;
  relocation_offered: boolean;
  work_authorization: string | null;
  end_date: string | null;
  duration_value: number | null;
  duration_unit: string | null;
  extension_possible: boolean;
  hours_per_week: number | null;
  source_system: string | null;
  external_req_id: string | null;
  imported_at: string | null;

  // ---- Gated financial-planning fields (🔒 requisition:view:financials) -
  // Masked on read by the field-masking financials map (LB-4) when the
  // actor lacks requisition:view:financials — omitted from the JSON, NOT
  // null (the absent-from-JSON contract, mirroring compensation masking).
  target_margin_percent: string | null;
  markup_percent_target: string | null;
  rate_card_id: string | null;
  min_bill_rate: string | null;
  max_bill_rate: string | null;
  min_pay_rate: string | null;
  max_pay_rate: string | null;

  // ---- The seam (LB-2 / R3) — read-only; stamped by the mint, never
  // settable via create/update. NULL until a profile is generated+confirmed.
  golden_profile_id: string | null;
}
