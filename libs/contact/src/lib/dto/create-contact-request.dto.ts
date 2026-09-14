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
  // Contacts prototype parity — mark this contact primary for its company.
  // Promote demotes any prior primary (repo, transactional). Default false.
  is_primary?: boolean;
  reports_to_id?: string;
  owner_id?: string;
  // Contact-spec amendment v1.0 — closed-vocab (validated app-layer via
  // assertContactVocab; see contact-vocab.ts). Optional; omitted = unclassified.
  relationship_role?: string;
  preference?: string;
}
