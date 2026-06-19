// Hand-mirrored from libs/company/src/lib/dto/company.view.ts. Source-
// annotated so a future BE shape change is caught by the failing build
// (the missing field) — not by silent drift at runtime. R2 hand-mirrors
// instead of importing @aramo/company (a forbidden domain edge from
// apps/ats-web). Flat field list (no enum / matrix logic) — the
// R1 structural-deep-equal drift-spec pattern is not applied (rule of
// three — that pattern is for mirrored logic, not flat fields).

export interface CompanyView {
  readonly id: string;
  readonly tenant_id: string;
  readonly site_id: string | null;
  readonly name: string;
  readonly address: string | null;
  readonly address2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly zip: string | null;
  readonly phone1: string | null;
  readonly phone2: string | null;
  readonly fax_number: string | null;
  readonly url: string | null;
  readonly key_technologies: string | null;
  readonly notes: string | null;
  readonly is_hot: boolean;
  readonly billing_contact_id: string | null;
  readonly owner_id: string | null;
  readonly entered_by_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;

  // Company-Fields v1.1 — un-gated additive fields.
  readonly status: string;
  readonly description: string | null;
  readonly industry: string | null;
  readonly country: string | null;
  readonly employee_count_band: string | null;
  readonly annual_revenue_band: string | null;
  readonly founded_year: number | null;
  readonly ownership_type: string | null;
  readonly registration_number: string | null;
  readonly source: string | null;
  readonly client_tier: string | null;
  readonly supplier_status: string | null;
  readonly exclusivity: boolean;
  readonly off_limits: boolean;
  readonly tags: readonly string[];
  readonly general_email: string | null;
  readonly last_activity_at: string | null;
  readonly next_action_at: string | null;

  // Address-Autocomplete v1.0 — provider place reference (un-gated).
  readonly address_provider_place_id: string | null;
  readonly address_provider: string | null;

  // Company-Fields v1.1 — GATED commercial fields. The apps/api field-masking
  // interceptor OMITS these keys (absent from JSON, not null) for actors
  // lacking company:read_commercial — hence optional here.
  readonly fee_model?: string | null;
  readonly default_contract_markup_pct?: string | null;
  readonly default_perm_fee_pct?: string | null;
  readonly payment_terms?: string | null;
  readonly credit_status?: string | null;
  readonly default_currency?: string | null;
}

export interface CompanyListResponse {
  readonly items: readonly CompanyView[];
}

// Company-Fields v1.1 — hand-mirrored from
// libs/company/src/lib/dto/company-department.view.ts. The CompanyDepartment
// model + CRUD sub-routes already existed; this PR surfaces them in the form
// (FE-only — no schema change).
export interface CompanyDepartmentView {
  readonly id: string;
  readonly tenant_id: string;
  readonly site_id: string | null;
  readonly company_id: string;
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CompanyDepartmentListResponse {
  readonly items: readonly CompanyDepartmentView[];
}

export interface CreateCompanyDepartmentRequest {
  readonly name: string;
}

// Hand-mirrored from libs/contact/src/lib/dto/contact.view.ts. Source-
// annotated. R3 hand-mirrors instead of importing @aramo/contact (a
// forbidden domain edge). Flat field list — no drift spec.
export interface ContactView {
  readonly id: string;
  readonly tenant_id: string;
  readonly site_id: string | null;
  readonly first_name: string;
  readonly last_name: string;
  readonly title: string | null;
  readonly email1: string | null;
  readonly email2: string | null;
  readonly phone_work: string | null;
  readonly phone_cell: string | null;
  readonly phone_other: string | null;
  readonly address: string | null;
  readonly company_id: string;
  readonly company_department_id: string | null;
  readonly is_hot: boolean;
  readonly notes: string | null;
  readonly left_company: boolean;
  readonly reports_to_id: string | null;
  readonly owner_id: string | null;
  readonly entered_by_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  // Contact-spec amendment v1.0 — list/detail surface fields (hand-mirrored
  // from libs/contact/src/lib/dto/contact.view.ts). relationship_role /
  // preference are closed-vocab; last_activity_at + company_name are read-time
  // enrichment (company_name resolved cross-schema on paged/detail reads).
  readonly relationship_role: string | null;
  readonly preference: string | null;
  readonly last_activity_at: string | null;
  readonly company_name: string | null;
}

export interface ContactListResponse {
  readonly items: readonly ContactView[];
}

// R6' — hand-mirrored CREATE/PATCH request shapes.
// Source: libs/company/src/lib/dto/create-company-request.dto.ts
//       + libs/company/src/lib/dto/update-company-request.dto.ts
// Flat-fields hand-mirror (no drift spec — rule of three: that pattern
// is for mirrored LOGIC, not flat DTO field lists).
//
// Tiered field set (ruling A): name + most-used inline; the address
// block / secondary phones / fax behind the form's "More fields" collapse.
// The DTO accepts all fields uniformly — tiering is a UX concern only.
//
// billing_contact_id (ruling B): the DTO accepts it on CREATE, but
// the form omits it on CREATE (chicken-and-egg: a new company has no
// contacts yet). EDIT-only.
//
// owner_id (ruling F): no GET /v1/users:assignable endpoint today —
// the form does not surface a picker. Server defaults owner_id to
// entered_by_id (the creating recruiter).
export interface CreateCompanyRequest {
  readonly name: string;
  readonly address?: string;
  readonly address2?: string;
  readonly city?: string;
  readonly state?: string;
  readonly zip?: string;
  readonly phone1?: string;
  readonly phone2?: string;
  readonly fax_number?: string;
  readonly url?: string;
  readonly key_technologies?: string;
  readonly notes?: string;
  readonly is_hot?: boolean;

  // Company-Fields v1.1 — un-gated additive fields.
  readonly status?: string;
  readonly description?: string;
  readonly industry?: string;
  readonly country?: string;
  readonly employee_count_band?: string;
  readonly annual_revenue_band?: string;
  readonly founded_year?: number;
  readonly ownership_type?: string;
  readonly registration_number?: string;
  readonly source?: string;
  readonly client_tier?: string;
  readonly supplier_status?: string;
  readonly exclusivity?: boolean;
  readonly off_limits?: boolean;
  readonly tags?: readonly string[];
  readonly general_email?: string;

  // Address-Autocomplete v1.0 — provider place reference, set by the FE when
  // the address block was populated via the typeahead. Omitted for a
  // manually-typed address.
  readonly address_provider_place_id?: string;
  readonly address_provider?: string;

  // Company-Fields v1.1 — gated commercial (sent only by holders; stripped
  // server-side for non-holders).
  readonly fee_model?: string;
  readonly default_contract_markup_pct?: string;
  readonly default_perm_fee_pct?: string;
  readonly payment_terms?: string;
  readonly credit_status?: string;
  readonly default_currency?: string;
}

// PATCH semantics: omit=unchanged; null=clear. Same shape as R4's
// UpdateRequisitionRequest + R5's UpdateTalentRecordRequest. name
// stays non-nullable (required field; PATCH may rename but not clear).
export interface UpdateCompanyRequest {
  readonly name?: string;
  readonly address?: string | null;
  readonly address2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly zip?: string | null;
  readonly phone1?: string | null;
  readonly phone2?: string | null;
  readonly fax_number?: string | null;
  readonly url?: string | null;
  readonly key_technologies?: string | null;
  readonly notes?: string | null;
  readonly is_hot?: boolean;
  readonly billing_contact_id?: string | null;
  // Owner reassignment — the BE update DTO accepts owner_id (the R6' mirror
  // omitted it). Used by the list "Assign to me" bulk action (company:edit).
  readonly owner_id?: string | null;

  // Company-Fields v1.1 — un-gated additive (omit=unchanged, null=clear).
  readonly status?: string;
  readonly description?: string | null;
  readonly industry?: string | null;
  readonly country?: string | null;
  readonly employee_count_band?: string | null;
  readonly annual_revenue_band?: string | null;
  readonly founded_year?: number | null;
  readonly ownership_type?: string | null;
  readonly registration_number?: string | null;
  readonly source?: string | null;
  readonly client_tier?: string | null;
  readonly supplier_status?: string | null;
  readonly exclusivity?: boolean;
  readonly off_limits?: boolean;
  readonly tags?: readonly string[];
  readonly general_email?: string | null;

  // Company-Fields v1.1 — gated commercial (stripped server-side for non-holders).
  readonly fee_model?: string | null;
  readonly default_contract_markup_pct?: string | null;
  readonly default_perm_fee_pct?: string | null;
  readonly payment_terms?: string | null;
  readonly credit_status?: string | null;
  readonly default_currency?: string | null;
}

// Address-Autocomplete v1.0 — hand-mirrored from
// libs/company/src/lib/dto/address-suggestion.dto.ts + address-details.dto.ts.
// Backend-proxied provider lookup (the key never reaches the browser). Flat
// shapes — no drift spec (rule of three).
export interface AddressSuggestion {
  readonly place_id: string;
  readonly description: string;
  readonly primary_text: string;
  readonly secondary_text: string;
}

export interface AddressAutocompleteResponse {
  readonly suggestions: readonly AddressSuggestion[];
}

export interface AddressDetails {
  readonly place_id: string;
  readonly provider: string;
  readonly address: string | null;
  readonly address2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly zip: string | null;
  readonly country: string | null;
}

export interface AddressDetailsResponse {
  // null when the feature is disabled or the provider failed (never-block).
  readonly details: AddressDetails | null;
}
