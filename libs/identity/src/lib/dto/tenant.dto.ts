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
}
