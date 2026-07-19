import { Injectable } from '@nestjs/common';
import { TenantService, extractTenantSlugFromHost } from '@aramo/identity';

import { HostAuthProfileService } from './host-auth-profile.service.js';
import { deriveBaseFromHost } from './redirect-uri.js';

// Increment-3 PR-3.1 (§3a) — resolves a request host to BOTH its derived auth
// base (redirect/base resolution) AND its tenant's pinned Cognito
// identity_provider (Home Realm Discovery), from a SINGLE findActiveBySlug.
//
// SHARING CHOICE (§3a, reported): login previously did one findActiveBySlug in
// resolveIdentityProvider purely for the IdP hint. That exact lookup is what the
// tenant-host validation ALSO needs, so this service folds them: one indexed
// unique-slug read yields the IdP hint AND the isTenantHost signal — no double
// query per request. (Across login vs callback these are different requests, so
// each does its own single lookup — unavoidable; the OAuth exchange==authorize
// invariant holds because the browser presents the same Host on both legs.)
//
// Auth-Decoupling PR-1 (ADR-0021 §3, §2.3) — the resolver now CONSULTS the host
// auth-profile registry FIRST (registry row → this existing derivation → env
// chain, R-A1-3). On a registry MISS or ERROR it falls through to the unchanged
// path below (R-A1-2, fail-open). The return shape { derivedBase,
// identityProvider } is unchanged — no caller changes (§2.3), so the live
// recruiter login path is behaviour-preserving (R-A1-1).
//
// Fail-open on every non-happy path (a user must always reach a login): errors
// yield isTenantHost=false; dev/platform hosts still derive without the DB.
@Injectable()
export class HostBaseResolver {
  constructor(
    private readonly tenants: TenantService,
    private readonly hostAuthProfiles: HostAuthProfileService,
  ) {}

  async resolve(host: string | undefined): Promise<{
    derivedBase: string | null;
    identityProvider: string | null;
  }> {
    // Registry FIRST. A hit yields the same { derivedBase, identityProvider }
    // the legacy path would; a null (miss/error, incl. an empty registry) falls
    // through to the unchanged derivation below.
    const registry = await this.hostAuthProfiles.resolve(host);
    if (registry !== null) {
      return {
        derivedBase: registry.derivedBase,
        identityProvider: registry.identityProvider,
      };
    }

    let isTenantHost = false;
    let identityProvider: string | null = null;
    try {
      if (host !== undefined && host.length > 0) {
        const rootDomain = process.env['APP_ROOT_DOMAIN'] ?? 'aramo.ai';
        const slug = extractTenantSlugFromHost(host, rootDomain);
        if (slug !== null) {
          const tenant = await this.tenants.findActiveBySlug(slug);
          if (tenant !== null) {
            isTenantHost = true;
            identityProvider = tenant.identity_provider ?? null;
          }
        }
      }
    } catch {
      // Fail-open. dev/platform hosts don't need the DB, so deriveBaseFromHost
      // below can still return a base; the caller falls back to the env chain.
      isTenantHost = false;
      identityProvider = null;
    }
    const derivedBase = deriveBaseFromHost(host, { isTenantHost });
    return { derivedBase, identityProvider };
  }
}
