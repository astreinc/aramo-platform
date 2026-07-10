import { Injectable } from '@nestjs/common';
import { TenantService, extractTenantSlugFromHost } from '@aramo/identity';

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
// Fail-open on every non-happy path (a user must always reach a login): errors
// yield isTenantHost=false; dev/platform hosts still derive without the DB.
@Injectable()
export class HostBaseResolver {
  constructor(private readonly tenants: TenantService) {}

  async resolve(host: string | undefined): Promise<{
    derivedBase: string | null;
    identityProvider: string | null;
  }> {
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
