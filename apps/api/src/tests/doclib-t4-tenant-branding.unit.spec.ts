import { describe, expect, it, vi } from 'vitest';
import type { TenantRepository } from '@aramo/identity';

import { RtrTemplateTenantBrandingService } from '../rtr/rtr-template-tenant-branding.service.js';

// DOC-TEMPLATE-LIB-1 T-4 (§8.2, ADR-0034 D8) — the tenant branding an Aramo default is
// previewed with in Org Home: the organization.* values the profile holds (display_name →
// legal_name → name), blanks omitted, logo availability only (no fetch, no capture).
function repo(b: Awaited<ReturnType<TenantRepository['findBrandingById']>>): TenantRepository {
  return { findBrandingById: vi.fn().mockResolvedValue(b) } as unknown as TenantRepository;
}

describe('RtrTemplateTenantBrandingService', () => {
  it('maps the tenant profile to organization.* values and omits blanks', async () => {
    const svc = new RtrTemplateTenantBrandingService(
      repo({
        name: 'acme', display_name: '  ', legal_name: 'Acme Staffing LLC', logo_url: 'https://cdn.acme.test/logo.png',
        address_line1: '1 Main St', address_line2: null, city: 'Springfield', state_province: 'IL', postal_code: '62701', country_code: 'US',
      }),
    );
    expect(await svc.forTenant('t')).toEqual({
      organization_name: 'Acme Staffing LLC',
      logo_available: true,
      values: {
        'organization.name': 'Acme Staffing LLC',
        'organization.address_line1': '1 Main St',
        'organization.city': 'Springfield',
        'organization.region': 'IL',
        'organization.postal_code': '62701',
        'organization.country': 'US',
      },
    });
  });

  it('an unknown tenant yields no values and no logo', async () => {
    expect(await new RtrTemplateTenantBrandingService(repo(null)).forTenant('t')).toEqual({
      organization_name: null,
      logo_available: false,
      values: {},
    });
  });
});
