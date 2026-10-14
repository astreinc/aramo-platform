import { Injectable } from '@nestjs/common';
import { EntitlementRepository } from '@aramo/entitlement';

// IC-2 PR-6 — the LIVE product-entitlement read used by the mint/refresh gate
// (auth-service principal adapter, via IdentityCoreModule) and by the effective
// authorization resolver. A thin, uncached delegate over the entitlement-owned
// repository (HF2 INV-4: enforcement never bypasses the entitlement store):
// an entitlement removed from the store is refused on the very next mint,
// refresh or request. libs/identity already depends on @aramo/entitlement, so
// no consumer gains a new nx edge by reading entitlements through this seam.
@Injectable()
export class TenantEntitlementReader {
  constructor(private readonly entitlements: EntitlementRepository) {}

  async getCapabilities(tenant_id: string): Promise<ReadonlySet<string>> {
    return this.entitlements.getCapabilities(tenant_id);
  }
}
