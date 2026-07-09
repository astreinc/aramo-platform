// Platform-Console Increment-2 PR-2 (G1) — the tenant lifecycle audit read
// response. One row per tenant.* event, newest-first, in a { events: [...] }
// envelope. The raw event_payload is surfaced (the FE timeline renders
// before→after + reason from it); this is the rawer operator shape, deliberately
// distinct from the tenant-self AuditEventView (which redacts to a human detail).
export interface PlatformTenantAuditEventDto {
  event_type: string;
  created_at: string;
  actor_type: string;
  actor_id: string | null;
  event_payload: Record<string, unknown>;
}

export interface PlatformTenantAuditListResponseDto {
  events: PlatformTenantAuditEventDto[];
}
