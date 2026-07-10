// Platform-Console Increment-2 PR-1.5 (A1) — the platform-operator tenant-list
// response. The row is the lifecycle-triage shape (status + reason + the
// activated/suspended milestones + slug), NOT the profile/domain shape; the
// capability summary stays on the detail endpoint (PR-1). The envelope
// (`{ tenants: [...] }`) reserves room for pagination metadata later without a
// breaking change. Mirrors @aramo/identity's PlatformTenantListRow.
export interface PlatformTenantSummaryDto {
  id: string;
  name: string;
  slug: string | null;
  status: string;
  status_reason_code: string | null;
  status_changed_at: string;
  is_active: boolean;
  created_at: string;
  activated_at: string | null;
  suspended_at: string | null;
}

export interface PlatformTenantListResponseDto {
  tenants: PlatformTenantSummaryDto[];
}
