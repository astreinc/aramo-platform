// CreateCompanyRequestDto — POST /v1/companies payload.
//
// tenant_id is NOT accepted from the body — derived from AuthContext.tenant_id
// at the controller layer (cross-tenant write defense per Architecture §7.2).
// site_id, when provided, is matched against AuthContext.site_id by the
// RolesGuard via @RequireSiteMatch (query/path resolution).
export interface CreateCompanyRequestDto {
  name: string;
  site_id?: string;
  address?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone1?: string;
  phone2?: string;
  fax_number?: string;
  url?: string;
  key_technologies?: string;
  notes?: string;
  is_hot?: boolean;
  billing_contact_id?: string;
  owner_id?: string;

  // Company-Fields v1.1 — un-gated additive fields (String-not-enum;
  // closed-vocab values validated at the app layer, not the type). The
  // activity-rollup timestamps (last_activity_at / next_action_at) are
  // system-populated by other surfaces and are NOT accepted here.
  status?: string; // prospect|active|inactive|do_not_contact (default active)
  description?: string;
  industry?: string;
  country?: string;
  employee_count_band?: string;
  annual_revenue_band?: string;
  founded_year?: number;
  ownership_type?: string; // private|public|nonprofit|government
  registration_number?: string;
  source?: string;
  client_tier?: string; // a|b|c
  supplier_status?: string; // preferred|approved|exclusive|open
  exclusivity?: boolean;
  off_limits?: boolean; // do-not-source flag (default false)
  tags?: string[];
  general_email?: string;

  // Address-Autocomplete v1.0 — the provider place reference, set by the FE
  // when the address block was populated via the typeahead. Optional; a
  // manually-typed address omits them. address_provider disambiguates the
  // provider-specific place_id.
  address_provider_place_id?: string;
  address_provider?: string;

  // Company-Fields v1.1 — GATED commercial fields. Accepted only when the
  // actor holds company:read_commercial; stripped at the repository write
  // boundary otherwise (see commercial-write-strip.ts). Decimals are
  // string-typed on the wire (no float drift), per the compensation pattern.
  fee_model?: string; // contract|perm|both
  default_contract_markup_pct?: string;
  default_perm_fee_pct?: string;
  payment_terms?: string;
  credit_status?: string;
  default_currency?: string; // ISO-4217 (default USD)
}
