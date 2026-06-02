// CompanyDepartmentView — read projection for a CompanyDepartment row.
export interface CompanyDepartmentView {
  id: string;
  tenant_id: string;
  site_id: string | null;
  company_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}
