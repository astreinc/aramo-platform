import { Injectable } from '@nestjs/common';
import { TenantService, extractTenantSlugFromHost } from '@aramo/identity';
import type {
  HostContext,
  HostContextDirectory,
} from '@aramo/auth-core';

// Auth-Decoupling PR-5a (ADR-0021 §2) — the Aramo-side adapter implementing auth's
// HostContextDirectory. It OWNS slug extraction (R-P5a-1): extractTenantSlugFromHost
// (host, APP_ROOT_DOMAIN) → TenantService.findActiveBySlug → { context_id,
// identity_provider } | null. This is the ONLY code importing @aramo/identity for
// host resolution; host-base-resolver + host-auth-profile no longer do (the §4.5
// decoupling proof).
//
// FAIL-OPEN verbatim (R-P5a-4): every null case of extractTenantSlugFromHost
// (empty hostname, wrong suffix, bare apex, multi-label) → null; an inactive/absent
// tenant → null; ANY error → null (caught). It NEVER throws where the old inline
// code returned null.
@Injectable()
export class IdentityHostContextAdapter implements HostContextDirectory {
  constructor(private readonly tenants: TenantService) {}

  async resolveByHost(host: string): Promise<HostContext | null> {
    try {
      const rootDomain = process.env['APP_ROOT_DOMAIN'] ?? 'aramo.ai';
      const slug = extractTenantSlugFromHost(host, rootDomain);
      if (slug === null) return null;
      const tenant = await this.tenants.findActiveBySlug(slug);
      if (tenant === null) return null;
      return {
        context_id: tenant.id,
        identity_provider: tenant.identity_provider ?? null,
      };
    } catch {
      // Fail-open — a resolution error is a miss, never a throw.
      return null;
    }
  }
}
