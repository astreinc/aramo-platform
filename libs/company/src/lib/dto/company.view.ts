// CompanyView — the read-projection DTO returned by GET / LIST.
//
// Structurally identical to the Company Prisma model row, with timestamps
// flattened to ISO strings at the controller boundary (the repository
// returns Date instances; the controller serializes).
export interface CompanyView {
  id: string;
  tenant_id: string;
  site_id: string | null;
  name: string;
  address: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone1: string | null;
  phone2: string | null;
  fax_number: string | null;
  url: string | null;
  key_technologies: string | null;
  notes: string | null;
  is_hot: boolean;
  billing_contact_id: string | null;
  owner_id: string | null;
  entered_by_id: string | null;
  created_at: string;
  updated_at: string;

  // Company-Fields v1.1 — un-gated additive fields (always projected).
  status: string;
  description: string | null;
  industry: string | null;
  country: string | null;
  employee_count_band: string | null;
  annual_revenue_band: string | null;
  founded_year: number | null;
  ownership_type: string | null;
  registration_number: string | null;
  source: string | null;
  client_tier: string | null;
  supplier_status: string | null;
  exclusivity: boolean;
  tags: string[];
  general_email: string | null;
  last_activity_at: string | null;
  next_action_at: string | null;

  // Address-Autocomplete v1.0 — the provider place reference (un-gated; always
  // projected). NULL for manually-entered companies.
  address_provider_place_id: string | null;
  address_provider: string | null;

  // Company-Fields v1.1 — GATED commercial fields. Projected here, but the
  // apps/api field-masking interceptor DELETES these keys for actors lacking
  // company:read_commercial (key absent from JSON, not null). Decimals are
  // serialized as strings (no float drift), per the compensation pattern.
  fee_model: string | null;
  default_contract_markup_pct: string | null;
  default_perm_fee_pct: string | null;
  payment_terms: string | null;
  credit_status: string | null;
  default_currency: string | null;
}
