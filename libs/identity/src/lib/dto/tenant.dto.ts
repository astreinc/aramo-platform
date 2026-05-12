// TenantDto — public shape of the Tenant entity. Returned by TenantService.getTenantsByUser.
export interface TenantDto {
  id: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
