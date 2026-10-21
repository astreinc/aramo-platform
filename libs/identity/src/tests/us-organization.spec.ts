import { describe, expect, it } from 'vitest';

import {
  US_STATE_CODES,
  authorityStatement,
  authorityStatementSha256,
  normalizeUsPhone,
  usProfileIneligibility,
  validateUsOrganizationDetails,
} from '../lib/util/us-organization.js';

// Aramo-Sign-Signup-Federated-Owner Amendment A1 (LOCKED) §2.2 — the field
// rules (US only: 50 states + DC; territories and military excluded; EIN optional).

const valid = {
  legal_name: 'Manjal Trading LLC',
  address_line1: '1600 Pennsylvania Ave NW',
  city: 'Washington',
  state_province: 'dc',
  postal_code: '20500',
  country_code: 'US',
  primary_contact_email: 'Billing@Manjal.co.in',
  primary_contact_name: 'Pat Owner',
  signer_title: 'Director',
};

function reasonOf(fn: () => unknown): { reason?: string; field?: string } {
  try {
    fn();
  } catch (e) {
    return (e as { context: { details: { reason?: string; field?: string } } }).context.details;
  }
  throw new Error('expected a refusal');
}

describe('validateUsOrganizationDetails', () => {
  it('accepts a complete US organization and normalizes it (EIN optional)', () => {
    const o = validateUsOrganizationDetails(valid, 'r');
    expect(o).toEqual({
      legal_name: 'Manjal Trading LLC',
      address_line1: '1600 Pennsylvania Ave NW',
      address_line2: null,
      city: 'Washington',
      state_province: 'DC',
      postal_code: '20500',
      country_code: 'US',
      primary_contact_email: 'billing@manjal.co.in',
      primary_contact_name: 'Pat Owner',
      signer_title: 'Director',
      primary_contact_phone: null,
      tax_id: null,
      registration_number: null,
    });
  });

  it('defaults the country to US and normalizes optional EIN, phone and ZIP+4', () => {
    const { country_code: _c, ...noCountry } = valid;
    const o = validateUsOrganizationDetails({ ...noCountry, tax_id: '123456789', primary_contact_phone: '(202) 555-0147', postal_code: '20500-0003' }, 'r');
    expect(o.country_code).toBe('US');
    expect(o.tax_id).toBe('12-3456789');
    expect(o.primary_contact_phone).toBe('+12025550147');
    expect(o.postal_code).toBe('20500-0003');
  });

  it.each(['IN', 'CA', 'GB'])('refuses country %s as organization_country_not_supported', (country) => {
    expect(reasonOf(() => validateUsOrganizationDetails({ ...valid, country_code: country }, 'r'))).toEqual({
      reason: 'organization_country_not_supported',
      field: 'country_code',
    });
  });

  it.each(['PR', 'GU', 'VI', 'AS', 'MP', 'AA', 'AE', 'AP', 'ZZ'])('refuses territory / military / unknown state %s', (state) => {
    expect(reasonOf(() => validateUsOrganizationDetails({ ...valid, state_province: state }, 'r'))).toEqual({
      reason: 'organization_country_not_supported',
      field: 'state_province',
    });
  });

  it.each([
    ['legal_name', { legal_name: ' ' }],
    ['address_line1', { address_line1: '' }],
    ['city', { city: undefined }],
    ['state_province', { state_province: '' }],
    ['postal_code', { postal_code: '2050' }],
    ['primary_contact_email', { primary_contact_email: 'nope' }],
    ['primary_contact_name', { primary_contact_name: '' }],
    ['signer_title', { signer_title: '' }],
    ['tax_id', { tax_id: '12-34' }],
    ['primary_contact_phone', { primary_contact_phone: '12' }],
  ] as const)('reports %s as organization_details_invalid', (field, patch) => {
    expect(reasonOf(() => validateUsOrganizationDetails({ ...valid, ...patch }, 'r'))).toEqual({ reason: 'organization_details_invalid', field });
  });

  it('refuses a missing organization object', () => {
    expect(reasonOf(() => validateUsOrganizationDetails(undefined, 'r'))).toEqual({ reason: 'organization_details_invalid', field: 'organization' });
  });
});

describe('US rules', () => {
  it('has exactly the 50 states + DC', () => {
    expect(US_STATE_CODES.size).toBe(51);
    expect(US_STATE_CODES.has('DC')).toBe(true);
    expect(US_STATE_CODES.has('PR')).toBe(false);
  });

  it('normalizeUsPhone', () => {
    expect(normalizeUsPhone('+1 415 555 0100')).toBe('+14155550100');
    expect(normalizeUsPhone('555-0100')).toBeNull();
  });

  it('usProfileIneligibility', () => {
    const p = { legal_name: 'X Inc', address_line1: '1 Main St', city: 'Austin', state_province: 'TX', postal_code: '78701', country_code: 'US', primary_contact_email: 'a@x.test' };
    expect(usProfileIneligibility(p)).toBeNull();
    expect(usProfileIneligibility({ ...p, country_code: 'IN' })).toBe('organization_country_not_supported');
    expect(usProfileIneligibility({ ...p, state_province: 'PR' })).toBe('organization_country_not_supported');
    expect(usProfileIneligibility({ ...p, city: null })).toBe('organization_profile_incomplete');
    expect(usProfileIneligibility({ ...p, postal_code: '7870' })).toBe('organization_profile_incomplete');
  });

  it('the authority statement is an attestation in the signer’s own words, hashed as a template', () => {
    expect(authorityStatement('Acme LLC')).toBe('I am authorized to act for Acme LLC and to accept the Aramo terms on its behalf.');
    expect(authorityStatementSha256()).toMatch(/^[0-9a-f]{64}$/);
  });
});
