// UpdateContactRequestDto — PATCH /v1/contacts/:id payload.
export interface UpdateContactRequestDto {
  company_department_id?: string | null;
  first_name?: string;
  last_name?: string;
  title?: string | null;
  email1?: string | null;
  email2?: string | null;
  phone_work?: string | null;
  phone_cell?: string | null;
  phone_other?: string | null;
  address?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  is_hot?: boolean;
  notes?: string | null;
  left_company?: boolean;
  // Contacts prototype parity — promote/demote primary. true promotes (and
  // demotes any prior primary for the company, transactional); false demotes.
  is_primary?: boolean;
  reports_to_id?: string | null;
  owner_id?: string | null;
  // Contact-spec amendment v1.0 — closed-vocab (validated app-layer via
  // assertContactVocab). PATCH semantics: omit=unchanged, null=clear.
  relationship_role?: string | null;
  preference?: string | null;
}
