import { describe, expect, it } from 'vitest';

import { companyToDraft, draftToPatch } from './company-overview-fields';
import type { CompanyView } from './types';

// Company detail inline edit — the draft→PATCH diff logic (the risk-bearing part
// of the in-place edit model): minimal diff, '' → null clearing, commercial
// gating, and Amendment-3 relationship de-select → INACTIVE.

function rel(type: string, status: string) {
  return {
    id: `rel-${type}`, type, status,
    effective_from: null, effective_to: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  };
}
function makeCompany(over: Partial<CompanyView> = {}): CompanyView {
  return {
    id: 'co-1', tenant_id: 't', site_id: null, name: 'Acme Corp',
    address: '1 Main St', address2: null, city: 'SF', state: 'CA', zip: null,
    phone1: null, phone2: null, fax_number: null, url: 'acme.com',
    key_technologies: null, notes: null, is_hot: false,
    billing_contact_id: null, owner_id: null, entered_by_id: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    status: 'active', relationships: [rel('CLIENT', 'ACTIVE')],
    master_status: 'ACTIVE', communication_restricted: false,
    description: 'A firm.', industry: 'Technology', country: 'US',
    employee_count_band: null, annual_revenue_band: null, founded_year: 2010,
    ownership_type: null, registration_number: null, source: null,
    client_tier: null, supplier_status: null, exclusivity: false,
    off_limits: false, tags: [], general_email: null,
    last_activity_at: null, next_action_at: null,
    address_provider_place_id: null, address_provider: null,
    ...over,
  };
}

describe('draftToPatch', () => {
  it('a no-op draft produces an empty patch', () => {
    const c = makeCompany();
    expect(draftToPatch(companyToDraft(c), c, true)).toEqual({});
  });

  it('diffs only the changed scalar fields', () => {
    const c = makeCompany();
    const d = { ...companyToDraft(c), industry: 'Banking', city: 'Oakland' };
    expect(draftToPatch(d, c, true)).toEqual({ industry: 'Banking', city: 'Oakland' });
  });

  it('clears a field to null when its draft value is emptied', () => {
    const c = makeCompany();
    const d = { ...companyToDraft(c), address: '' };
    expect(draftToPatch(d, c, true)).toEqual({ address: null });
  });

  it('founded_year: text → number; emptied → null', () => {
    const c = makeCompany({ founded_year: 2010 });
    expect(draftToPatch({ ...companyToDraft(c), founded_year: '1999' }, c, true)).toEqual({
      founded_year: 1999,
    });
    expect(draftToPatch({ ...companyToDraft(c), founded_year: '' }, c, true)).toEqual({
      founded_year: null,
    });
  });

  it('exclusivity Yes/No maps to boolean', () => {
    const c = makeCompany({ exclusivity: false });
    expect(draftToPatch({ ...companyToDraft(c), exclusivity: 'Yes' }, c, true)).toEqual({
      exclusivity: true,
    });
  });

  it('drops commercial keys from the patch without commercial access', () => {
    const c = makeCompany();
    const d = { ...companyToDraft(c), payment_terms: 'Net 45', industry: 'Retail' };
    // gated → commercial key omitted, non-commercial change kept
    expect(draftToPatch(d, c, false)).toEqual({ industry: 'Retail' });
    // ungated → both kept
    expect(draftToPatch(d, c, true)).toEqual({ payment_terms: 'Net 45', industry: 'Retail' });
  });

  it('adding a role emits relationships with the selected role + its status', () => {
    const c = makeCompany({ relationships: [rel('CLIENT', 'ACTIVE')] });
    const d = { ...companyToDraft(c), rel_VENDOR: 'true', rel_VENDOR_status: 'PROSPECT' };
    expect(draftToPatch(d, c, true)).toEqual({
      relationships: [
        { type: 'CLIENT', status: 'ACTIVE' },
        { type: 'VENDOR', status: 'PROSPECT' },
      ],
    });
  });

  it('de-selecting a present role transitions it to INACTIVE (Amendment 3), not delete', () => {
    const c = makeCompany({
      relationships: [rel('CLIENT', 'ACTIVE'), rel('VENDOR', 'ACTIVE')],
    });
    const d = { ...companyToDraft(c), rel_VENDOR: 'false' };
    expect(draftToPatch(d, c, true)).toEqual({
      relationships: [
        { type: 'CLIENT', status: 'ACTIVE' },
        { type: 'VENDOR', status: 'INACTIVE' },
      ],
    });
  });

  it('changing a role status emits the new status', () => {
    const c = makeCompany({ relationships: [rel('CLIENT', 'ACTIVE')] });
    const d = { ...companyToDraft(c), rel_CLIENT_status: 'INACTIVE' };
    expect(draftToPatch(d, c, true)).toEqual({
      relationships: [{ type: 'CLIENT', status: 'INACTIVE' }],
    });
  });
});
