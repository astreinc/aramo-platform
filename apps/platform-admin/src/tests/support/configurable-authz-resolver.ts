import type {
  EffectiveAuthorizationInput,
  EffectiveAuthorizationResolution,
  EffectiveAuthorizationResolver,
} from '@aramo/auth';

// HF-AUTH-1 — the platform-admin test resolver (MODE A).
//
// The compact token carries NO scopes; the shared JwtAuthGuard resolves them
// server-side through the EFFECTIVE_AUTHORIZATION_RESOLVER port. The platform-admin
// integration specs are authorization-BOUNDARY tests: the SAME principal is minted
// with DIFFERENT scope sets across tests (read-only vs lifecycle vs provision) to
// prove @RequireScopes admits/denies each route. A single seeded RBAC set cannot
// express that per-token variation, so these specs bind this configurable resolver
// and declare each token's scopes via grant().
//
// grant() allocates a FRESH authz_version per token and keys the scopes by
// (tenant, principal, version), returning the version to stamp into that token —
// so the same principal minted twice with different scopes each resolves to exactly
// its own set, with no last-grant-wins collision.
export class ConfigurableAuthzResolver implements EffectiveAuthorizationResolver {
  private counter = 0;
  private readonly byVersion = new Map<string, string[]>();

  grant(tenant_id: string, principal_id: string, scopes: string[]): number {
    const version = ++this.counter;
    this.byVersion.set(this.vkey(tenant_id, principal_id, version), [...scopes]);
    return version;
  }

  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const scopes = this.byVersion.get(
      this.vkey(input.tenant_id, input.principal_id, input.token_authz_version),
    );
    return { status: 'ok', scopes: scopes ?? [] };
  }

  private vkey(tenant_id: string, principal_id: string, version: number): string {
    return `${tenant_id}:${principal_id}:${String(version)}`;
  }
}
