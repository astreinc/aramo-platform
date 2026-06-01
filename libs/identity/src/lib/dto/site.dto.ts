// SiteDto — public shape of the Site entity (PR-A1a Ruling 4).
// Site is a sub-tenant partition within a Tenant; the axis lives in
// identity ONLY. Core (non-identity) schemas remain tenant_id-only.
export interface SiteDto {
  id: string;
  tenant_id: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
