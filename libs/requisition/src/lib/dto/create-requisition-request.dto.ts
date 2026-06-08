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
}
