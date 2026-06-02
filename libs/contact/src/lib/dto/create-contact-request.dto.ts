// CreateContactRequestDto — POST /v1/contacts payload.
//
// tenant_id is derived from AuthContext.tenant_id, not the body.
// company_id is REQUIRED (every contact belongs to a company).
export interface CreateContactRequestDto {
  company_id: string;
  first_name: string;
  last_name: string;
  site_id?: string;
  company_department_id?: string;
  title?: string;
  email1?: string;
  email2?: string;
  phone_work?: string;
  phone_cell?: string;
  phone_other?: string;
  address?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  is_hot?: boolean;
  notes?: string;
  reports_to_id?: string;
  owner_id?: string;
}
