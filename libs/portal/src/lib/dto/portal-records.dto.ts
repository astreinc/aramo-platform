import type { PortalProfileDto } from './portal-profile.dto.js';

// Portal P1 PR-2a — the records-list response (the engagement surface, P-R5).
// A closed envelope wrapping the portal user's per-record R10-filtered profiles
// across tenants. Each entry is the existing PortalProfileDto (talent_id,
// tenant_id, tenant_status, source_channel, created_at). Tenant COUNTERPARTY
// NAMING is permitted by P-R5 ("MAY") but deferred — tenant_id is the
// counterparty id and carries no origin-secrecy concern (a portal user's own
// engagements, not a verification origin).
export interface PortalRecordsResponseDto {
  records: PortalProfileDto[];
}
