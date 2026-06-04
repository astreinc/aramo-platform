export interface PlatformTenantSummaryDto {
  id: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PlatformTenantListResponseDto {
  tenants: PlatformTenantSummaryDto[];
}
