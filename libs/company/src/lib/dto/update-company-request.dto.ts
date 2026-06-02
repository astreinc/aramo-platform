// UpdateCompanyRequestDto — PATCH /v1/companies/:id payload.
//
// All fields optional (partial-update semantics). Identity fields
// (id / tenant_id / site_id) are not editable here — tenant move and
// site move are out of scope for a reference-CRUD update endpoint.
export interface UpdateCompanyRequestDto {
  name?: string;
  address?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone1?: string | null;
  phone2?: string | null;
  fax_number?: string | null;
  url?: string | null;
  key_technologies?: string | null;
  notes?: string | null;
  is_hot?: boolean;
  billing_contact_id?: string | null;
  owner_id?: string | null;
}
