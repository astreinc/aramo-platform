// ContactView — read projection for a Contact row.
export interface ContactView {
  id: string;
  tenant_id: string;
  site_id: string | null;
  company_id: string;
  company_department_id: string | null;
  first_name: string;
  last_name: string;
  title: string | null;
  email1: string | null;
  email2: string | null;
  phone_work: string | null;
  phone_cell: string | null;
  phone_other: string | null;
  address: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  is_hot: boolean;
  notes: string | null;
  left_company: boolean;
  reports_to_id: string | null;
  owner_id: string | null;
  entered_by_id: string | null;
  created_at: string;
  updated_at: string;
  // Contact-spec amendment v1.0 — list/detail surface fields.
  relationship_role: string | null;
  preference: string | null;
  last_activity_at: string | null;
  // Read-time enrichment — the contact's company display name, resolved via
  // the cross-schema company_id FK (UUID-only) through CompanyRepository.
  // Populated on the paged list + detail reads; null when the company row is
  // not resolvable in-tenant. NOT a stored column.
  company_name: string | null;
}
