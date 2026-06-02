import type { RequisitionStatus } from './requisition-status.js';

// CreateRequisitionRequestDto — POST /v1/requisitions payload.
// tenant_id is derived from AuthContext.tenant_id, never the body.
export interface CreateRequisitionRequestDto {
  title: string;
  company_id: string;
  site_id?: string;
  contact_id?: string;
  company_department_id?: string;
  status?: RequisitionStatus;
  type?: string;
  duration?: string;
  rate_max?: string;
  salary?: string;
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
}
