// Hand-mirrored from libs/company/src/lib/dto/company.view.ts. Source-
// annotated so a future BE shape change is caught by the failing build
// (the missing field) — not by silent drift at runtime. R2 hand-mirrors
// instead of importing @aramo/company (a forbidden domain edge from
// apps/recruiter-console). Flat field list (no enum / matrix logic) — the
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
}

export interface CompanyListResponse {
  readonly items: readonly CompanyView[];
}
