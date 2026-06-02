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
}
