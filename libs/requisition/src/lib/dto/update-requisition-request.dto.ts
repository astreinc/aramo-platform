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
  rate_max?: string | null;
  salary?: string | null;
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
}
