import type { RequisitionStatus } from './requisition-status.js';

// UpdateRequisitionRequestDto — PATCH /v1/requisitions/:id payload.
// `status` is freely editable here per directive §4 (simple enum, NOT
// a state machine — no canTransition guard).
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
}
