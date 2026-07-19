import { Injectable } from '@nestjs/common';
import { TenantService, extractTenantSlugFromHost } from '@aramo/identity';
import {
  HostAuthProfileStore,
  type HostAuthProfileDto,
  type HostClass,
} from '@aramo/auth-storage';

import { isDevHostname, parseHost } from './redirect-uri.js';

// Auth-Decoupling PR-1 §2.2 (ADR-0021 §3, ADR-0020 rule 2) — the host
// auth-profile registry CLASSIFIER. Resolves a request host to its seeded class
// profile + the derived auth base + IdP hint, or null (a MISS → the caller falls
// through to the legacy path, R-A1-3).
//
// BEHAVIOUR-PRESERVING (R-A1-1). The classification order MIRRORS
// deriveBaseFromHost (redirect-uri.ts) exactly:
//   dev-localhost → PLATFORM exact → PORTAL exact → TENANT (slug-validated) → miss
// and it REUSES parseHost for host normalisation (§2.1 — not re-implemented).
//
// FAIL-OPEN (R-A1-2): every non-happy path — an empty/erroring registry, an
// unparseable host, a dev host, a TENANT-shaped host with no active tenant —
// returns null so HostBaseResolver falls through to the retained env chain. Fail-
// closed is an ADR-0021 PR-5 question; it is NOT introduced here.
//
// The Cognito profile columns on the row (pool_id/client_id/issuer/domain) are
// carried but INERT (R-A1-5): nothing reads them in PR-1. Only derivedBase and
// identityProvider affect behaviour, and both reproduce the legacy result.
export interface HostAuthResolution {
  readonly hostClass: HostClass;
  readonly profile: HostAuthProfileDto;
  readonly derivedBase: string;
  readonly identityProvider: string | null;
}

// Normalise a stored PLATFORM/PORTAL host_pattern to a bare hostname for exact
// comparison — the same lower/trim/last-colon port-strip parseHost applies, so a
// seeded pattern matches an inbound host identically. (The seed already writes
// normalised patterns; this is belt-and-braces so a hand-edited row can't drift.)
function normalizePattern(pattern: string): string {
  const p = pattern.trim().toLowerCase();
  const colon = p.lastIndexOf(':');
  return colon === -1 ? p : p.slice(0, colon);
}

@Injectable()
export class HostAuthProfileService {
  constructor(
    private readonly store: HostAuthProfileStore,
    private readonly tenants: TenantService,
  ) {}

  async resolve(host: string | undefined): Promise<HostAuthResolution | null> {
    try {
      const parsed = parseHost(host);
      if (parsed === null) return null;

      // dev-localhost is FIRST in deriveBaseFromHost's order and is NOT a
      // registry class — defer it to the legacy dev-posture path (which owns the
      // http://<host:port> dev base). Returning null here preserves the ordering
      // AND keeps the closed vocab to TENANT|PLATFORM|PORTAL.
      if (isDevHostname(parsed.hostname)) return null;

      const byClass = await this.store.activeByClass();
      if (byClass.size === 0) return null; // empty registry → fall through

      // PLATFORM exact-match.
      const platform = byClass.get('PLATFORM');
      if (platform !== undefined && normalizePattern(platform.host_pattern) === parsed.hostname) {
        return this.hit('PLATFORM', platform, parsed.hostname, platform.default_idp);
      }

      // PORTAL exact-match (sibling to PLATFORM).
      const portal = byClass.get('PORTAL');
      if (portal !== undefined && normalizePattern(portal.host_pattern) === parsed.hostname) {
        return this.hit('PORTAL', portal, parsed.hostname, portal.default_idp);
      }

      // TENANT (slug-validated). Composes the class row with the tenant's own
      // identity_provider from the EXISTING findActiveBySlug read (R-A1-7). The
      // root domain source is APP_ROOT_DOMAIN — byte-identical to the legacy
      // HostBaseResolver (env chain retained, R-A1-3) — so classification agrees
      // with extractTenantSlugFromHost on every host.
      const tenantRow = byClass.get('TENANT');
      if (tenantRow !== undefined) {
        const rootDomain = process.env['APP_ROOT_DOMAIN'] ?? 'aramo.ai';
        const slug = extractTenantSlugFromHost(host as string, rootDomain);
        if (slug !== null) {
          const tenant = await this.tenants.findActiveBySlug(slug);
          if (tenant !== null) {
            // TENANT default_idp is OVERRIDDEN per-request by the tenant's own
            // provider (§2.1); with a null class default this is exactly the
            // legacy `tenant.identity_provider ?? null`.
            const idp = tenant.identity_provider ?? tenantRow.default_idp ?? null;
            return this.hit('TENANT', tenantRow, parsed.hostname, idp);
          }
        }
      }

      return null; // no class matched → fall through
    } catch {
      // Fail-open (R-A1-2): any registry error yields a miss; the caller's legacy
      // path still resolves a base (dev/platform hosts don't even need the DB).
      return null;
    }
  }

  private hit(
    hostClass: HostClass,
    profile: HostAuthProfileDto,
    hostname: string,
    identityProvider: string | null,
  ): HostAuthResolution {
    // Every registry class derives `https://<hostname>` — identical to
    // deriveBaseFromHost's platform/portal/tenant branches. (Dev's http://<raw>
    // is handled by the deferred legacy path, never here.)
    return { hostClass, profile, derivedBase: `https://${hostname}`, identityProvider };
  }
}
