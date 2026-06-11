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

  // Company-Fields v1.1 — un-gated additive fields (partial-update; null
  // clears). Activity-rollup timestamps are system-populated, not editable.
  status?: string;
  description?: string | null;
  industry?: string | null;
  country?: string | null;
  employee_count_band?: string | null;
  annual_revenue_band?: string | null;
  founded_year?: number | null;
  ownership_type?: string | null;
  registration_number?: string | null;
  source?: string | null;
  client_tier?: string | null;
  supplier_status?: string | null;
  exclusivity?: boolean;
  tags?: string[];
  general_email?: string | null;

  // Address-Autocomplete v1.0 — the provider place reference (partial-update;
  // null clears). Set when an address is (re)populated via the typeahead.
  address_provider_place_id?: string | null;
  address_provider?: string | null;

  // Company-Fields v1.1 — GATED commercial fields (stripped for non-holders
  // at the repository write boundary — a non-holder edit never nulls an
  // existing commercial value).
  fee_model?: string | null;
  default_contract_markup_pct?: string | null;
  default_perm_fee_pct?: string | null;
  payment_terms?: string | null;
  credit_status?: string | null;
  default_currency?: string | null;
}
