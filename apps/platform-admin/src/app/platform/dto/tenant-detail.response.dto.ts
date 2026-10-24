import type { TenantDto } from '@aramo/identity';

// PLATFORM-UX-1 B-1b (directive R-7) — the operator tenant-detail envelope
// (GET /platform/tenants/:tenant_id). The identity TenantDto plus the tenant's
// subdomain `slug` (or null), additive only. TenantDto itself is NOT widened
// (it is the shared session-mint / login shape); the slug is read separately.
export interface PlatformTenantDetailDto extends TenantDto {
  slug: string | null;
}

export interface PlatformTenantDetailResponseDto {
  tenant: PlatformTenantDetailDto;
}
