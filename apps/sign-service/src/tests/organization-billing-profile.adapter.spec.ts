import type { OrganizationRegionService, TenantRepository } from '@aramo/identity';
import { describe, expect, it, vi } from 'vitest';

import { OrganizationBillingProfileAdapter } from '../app/billing/organization-billing-profile.adapter.js';

// Sign Signup Amendment A1 (Organization Details, US only) §2.6 — the sign-service
// binding of the organization billing profile port: eligible only for a complete
// US (50 states + DC) profile; checkout locks the tenant to the US.

const US = {
  id: 't-1',
  name: 'Acme',
  legal_name: ' Acme Holdings LLC ',
  display_name: null,
  address_line1: '1 Main St',
  address_line2: '',
  city: 'Austin',
  state_province: 'tx',
  postal_code: '78701',
  country_code: 'us',
  tax_id: null,
  registration_number: null,
  primary_contact_name: 'Pat Owner',
  primary_contact_email: 'billing@acme.test',
  primary_contact_phone: null,
  logo_url: null,
  updated_at: new Date(0),
};

function adapter(profile: unknown) {
  const tenants = { findProfileById: vi.fn(async () => profile) } as unknown as TenantRepository;
  const regions = { lockUs: vi.fn(async () => undefined) } as unknown as OrganizationRegionService;
  return { a: new OrganizationBillingProfileAdapter(tenants, regions), regions };
}

describe('OrganizationBillingProfileAdapter', () => {
  it('maps a complete US profile to the billing profile', async () => {
    expect(await adapter(US).a.eligibleProfile('t-1')).toEqual({
      profile: {
        legal_name: 'Acme Holdings LLC',
        billing_email: 'billing@acme.test',
        address: { line1: '1 Main St', line2: null, city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' },
      },
    });
    expect(await adapter({ ...US, address_line2: 'Suite 2' }).a.eligibleProfile('t-1')).toMatchObject({ profile: { address: { line2: 'Suite 2' } } });
  });

  it('refuses non-US, excluded (territory / military) and incomplete profiles', async () => {
    expect(await adapter({ ...US, country_code: 'CA' }).a.eligibleProfile('t-1')).toEqual({ refused: 'organization_country_not_supported' });
    expect(await adapter({ ...US, state_province: 'PR' }).a.eligibleProfile('t-1')).toEqual({ refused: 'organization_country_not_supported' });
    expect(await adapter({ ...US, state_province: 'AE' }).a.eligibleProfile('t-1')).toEqual({ refused: 'organization_country_not_supported' });
    expect(await adapter({ ...US, legal_name: null }).a.eligibleProfile('t-1')).toEqual({ refused: 'organization_profile_incomplete' });
    expect(await adapter({ ...US, postal_code: '7870' }).a.eligibleProfile('t-1')).toEqual({ refused: 'organization_profile_incomplete' });
    expect(await adapter({ ...US, country_code: null }).a.eligibleProfile('t-1')).toEqual({ refused: 'organization_profile_incomplete' });
    expect(await adapter(null).a.eligibleProfile('t-1')).toEqual({ refused: 'organization_profile_incomplete' });
  });

  it('locks the tenant profile to the US', async () => {
    const { a, regions } = adapter(US);
    await a.lockRegion('t-1');
    expect(regions.lockUs).toHaveBeenCalledWith('t-1');
  });
});
