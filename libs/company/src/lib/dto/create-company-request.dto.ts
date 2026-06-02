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
}
