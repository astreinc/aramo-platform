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
}
