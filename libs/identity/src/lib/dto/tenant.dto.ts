// TenantDto — public shape of the Tenant entity. Returned by TenantService.getTenantsByUser.
export interface TenantDto {
  id: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  // Subdomain-Identity Directive B — the tenant's pinned Cognito Hosted-UI
  // identity_provider string (e.g. 'microsoft'), or null = show the chooser.
  // Surfaced so the login redirect (auth-service) can read it off the tenant
  // resolved by findActiveBySlug and pin Home Realm Discovery.
  identity_provider: string | null;
  // Platform-Console Increment-2 PR-1 — tenant lifecycle status (one of
  // TENANT_STATUSES). Surfaced so the session-mint gate (auth-service) reads
  // selectedTenant.status with no extra query (the smallest correct read for
  // workstream E) and the platform console can filter/list by status.
  status: string;
}
