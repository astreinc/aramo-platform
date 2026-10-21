import type { TemplateTenantBrandingPort, TenantBrandingView } from '@aramo/documents';
import { type TenantRepository } from '@aramo/identity';

import { organizationName } from './rtr-template-binding.service.js';

// DOC-TEMPLATE-LIB-1 T-4 (§8.2, ADR-0034 D8) — the tenant branding an Aramo default is
// previewed with in the Org Home gallery: the organization.* catalog values the tenant
// profile holds (the SAME sources the RTR binding resolvers read at generation:
// findBrandingById, organizationName display_name → legal_name → name) and whether a
// profile logo exists. Read-only — no logo fetch/capture, no asset, no Document. A value
// the tenant has not recorded is omitted (the preview keeps the fixed sample for it).
export class RtrTemplateTenantBrandingService implements TemplateTenantBrandingPort {
  constructor(private readonly tenants: TenantRepository) {}

  async forTenant(tenant_id: string): Promise<TenantBrandingView> {
    const b = await this.tenants.findBrandingById(tenant_id);
    const name = organizationName(b);
    const values: Record<string, string> = {};
    const put = (key: string, v: string | null | undefined): void => {
      const t = (v ?? '').trim();
      if (t.length > 0) values[key] = t;
    };
    put('organization.name', name);
    put('organization.address_line1', b?.address_line1);
    put('organization.address_line2', b?.address_line2);
    put('organization.city', b?.city);
    put('organization.region', b?.state_province);
    put('organization.postal_code', b?.postal_code);
    put('organization.country', b?.country_code);
    return { organization_name: name, logo_available: (b?.logo_url ?? '').trim().length > 0, values };
  }
}
