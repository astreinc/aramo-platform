import { Inject, Injectable } from '@nestjs/common';
import type {
  EffectiveAuthorizationInput,
  EffectiveAuthorizationResolution,
  EffectiveAuthorizationResolver,
} from '@aramo/auth';

import { AuthorizationVersionService } from '../authorization-version.service.js';
import { RoleService } from '../role.service.js';
import { TenantEntitlementReader } from '../tenant-entitlement-reader.service.js';

import { filterScopesForConsumer } from './consumer-scope-policy.js';
import { AUTHORIZATION_SCOPE_CACHE, type AuthorizationScopeCache } from './scope-cache.port.js';

// HF-AUTH-1 resolver config, bound at the app composition root. `portalScopes` is
// the fixed passwordless-portal session scope set (auth-core's
// PORTAL_SESSION_SCOPES), passed in so libs/identity does not take an auth-core
// dependency. `scopeCacheTtlSeconds` bounds a cached snapshot's lifetime.
export const AUTHZ_RESOLVER_CONFIG = 'AUTHZ_RESOLVER_CONFIG' as const;
export interface AuthzResolverConfig {
  portalScopes: readonly string[];
  scopeCacheTtlSeconds: number;
}

// HF-AUTH-1 — the identity-backed EffectiveAuthorizationResolver.
//
// Authority order (locked): Postgres RBAC (RoleService) + AuthorizationVersion are
// the AUTHORITY; the scope cache is a versioned PERFORMANCE layer; the JWT is
// identity + an authz_version reference. The compact token carries NO scopes.
//
// Per request the guard/cookie-verifier call resolve():
//   1. Determine the CURRENT authoritative authz_version for the principal.
//      Portal = fixed authorization (version pinned to 1). Recruiter/platform =
//      the AuthorizationVersion row (a single indexed PK read — the cheap
//      authoritative lookup; the EXPENSIVE RBAC scope traversal is what the cache
//      spares). Reading the version authoritatively is what makes revocation
//      IMMEDIATE: a bump moves the current version away from the token's, so the
//      very next request is `stale`.
//   2. token_authz_version !== current  → `stale` (immediate revocation).
//   3. match → resolve the effective scope set, cached under an IMMUTABLE
//      version+site key. Cache MISS → resolve from canonical RBAC + populate.
//      Cache UNREACHABLE → resolve from canonical RBAC WITHOUT caching (still
//      proves authorization — allowed).
//   4. Canonical RBAC unreachable → `unresolvable` → the caller FAILS CLOSED. The
//      cache is NEVER allowed to expand privilege, and the token's own (absent)
//      scopes are never trusted.
@Injectable()
export class IdentityEffectiveAuthorizationResolver implements EffectiveAuthorizationResolver {
  constructor(
    private readonly roles: RoleService,
    private readonly versions: AuthorizationVersionService,
    @Inject(AUTHORIZATION_SCOPE_CACHE) private readonly cache: AuthorizationScopeCache,
    @Inject(AUTHZ_RESOLVER_CONFIG) private readonly config: AuthzResolverConfig,
    // IC-2 PR-6 — LIVE entitlement read for the esign namespace (never cached).
    private readonly entitlements: TenantEntitlementReader,
  ) {}

  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    // Portal: fixed authorization set, version pinned to 1. No RBAC membership
    // backs a portal principal, so its effective scopes never change with grants.
    if (input.consumer_type === 'portal') {
      if (input.token_authz_version !== 1) return { status: 'stale' };
      return { status: 'ok', scopes: [...this.config.portalScopes] };
    }

    // Recruiter / platform (and any other tenant principal): authoritative version.
    let currentVersion: number;
    try {
      currentVersion = await this.versions.getCurrentVersion({
        tenant_id: input.tenant_id,
        principal_id: input.principal_id,
      });
    } catch {
      // Cannot reach the authority to prove the version → fail closed.
      return { status: 'unresolvable' };
    }

    if (input.token_authz_version !== currentVersion) {
      return { status: 'stale' };
    }

    // Version matches — resolve the effective scope set (cached by immutable
    // version+site key).
    const key = this.cacheKey(input, currentVersion);

    let cached: string[] | null = null;
    let cacheReachable = true;
    try {
      cached = await this.cache.get(key);
    } catch {
      cacheReachable = false; // cache down → fall through to canonical RBAC
    }
    if (cached !== null) {
      return { status: 'ok', scopes: await this.forConsumer(input, cached) };
    }

    let scopes: string[];
    try {
      scopes = await this.resolveFromCanonical(input);
    } catch {
      // Canonical store unreachable → cannot prove authorization → fail closed.
      return { status: 'unresolvable' };
    }

    if (cacheReachable) {
      try {
        await this.cache.set(key, scopes, this.config.scopeCacheTtlSeconds);
      } catch {
        // Cache write failure is non-fatal — the resolution is already proven.
      }
    }
    return { status: 'ok', scopes: await this.forConsumer(input, scopes) };
  }

  // IC-2 PR-6 (IC-0 §F.2 rule 4) — the per-consumer scope-namespace filter,
  // applied AFTER the cached canonical set is read so a cached snapshot can
  // never widen a token; the esign capability is read LIVE (uncached) so a
  // removed entitlement stops esign:* on the very next request. A canonical set
  // is cached per (tenant, principal, version, site, consumer).
  private async forConsumer(
    input: EffectiveAuthorizationInput,
    canonical: string[],
  ): Promise<string[]> {
    let tenantHasEsign = false;
    if (input.consumer_type === 'sign') {
      // Fail closed: an unreadable entitlement store yields NO esign scopes.
      try {
        tenantHasEsign = (await this.entitlements.getCapabilities(input.tenant_id)).has('sign');
      } catch {
        tenantHasEsign = false;
      }
    }
    return filterScopesForConsumer({
      consumer: input.consumer_type,
      scopes: canonical,
      tenantHasEsign,
    });
  }

  // Canonical RBAC resolution — site-aware union (tenant-wide ∪ site-matched), the
  // exact set the pre-HF-AUTH-1 token carried, now resolved server-side.
  private async resolveFromCanonical(input: EffectiveAuthorizationInput): Promise<string[]> {
    return this.roles.getScopesByUserTenantAndSite({
      user_id: input.principal_id,
      tenant_id: input.tenant_id,
      ...(input.site_id === undefined ? {} : { site_id: input.site_id }),
    });
  }

  // Version + site are BOTH in the key: version keeps entries immutable (a bump
  // uses a new key), site keeps a site-scoped token's set distinct from the
  // tenant-wide one. Tenant + principal isolate across tenants.
  private cacheKey(input: EffectiveAuthorizationInput, version: number): string {
    const site = input.site_id ?? '-';
    // IC-2 PR-6: the consumer is part of the key (two consumers on one identity
    // are two authorizations; a snapshot resolved for one never serves the other).
    return `authz:${input.tenant_id}:${input.principal_id}:${String(version)}:${site}:${input.consumer_type}`;
  }
}
