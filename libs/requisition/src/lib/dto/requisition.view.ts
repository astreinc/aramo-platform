import type { RequisitionStatus } from './requisition-status.js';

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
  rate_max: string | null;
  salary: string | null;
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
}
