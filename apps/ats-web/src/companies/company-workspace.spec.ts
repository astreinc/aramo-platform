import { describe, expect, it } from 'vitest';

import type { CompanyRelationshipView, CompanyView } from './types';
import {
  EMPTY_FACETS,
  buildCompanyQuery,
  companyTypes,
  daysSinceContact,
  deriveIndustries,
  inScope,
  isQuiet,
  lastContactLabel,
  matchesText,
  passesFacets,
  primaryStatus,
  relStatusLabel,
  relTypeLabel,
  tabCountFrom,
  tierLabel,
} from './company-workspace';

// Company Party/Role (ADR-0032) — the workspace projection/filter layer now
// reads the real relationships[] axis (type + status), not the retired status.

function rel(over: Partial<CompanyRelationshipView> = {}): CompanyRelationshipView {
  return {
    id: 'r-1',
    type: 'CLIENT',
    status: 'ACTIVE',
    effective_from: '2026-01-01T00:00:00Z',
    effective_to: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function make(overrides: Partial<CompanyView> = {}): CompanyView {
  return {
    id: 'co-1',
    tenant_id: 't',
    site_id: null,
    name: 'Acme Corp',
    address: null,
    address2: null,
    city: 'Austin',
    state: 'TX',
    zip: null,
    phone1: null,
    phone2: null,
    fax_number: null,
    url: null,
    key_technologies: null,
    notes: null,
    is_hot: false,
    billing_contact_id: null,
    owner_id: null,
    entered_by_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    status: 'active',
    master_status: 'ACTIVE',
    communication_restricted: false,
    relationships: [rel()],
    description: null,
    industry: 'Robotics',
    country: null,
    employee_count_band: null,
    annual_revenue_band: null,
    founded_year: null,
    ownership_type: null,
    registration_number: null,
    source: null,
    client_tier: null,
    supplier_status: null,
    exclusivity: false,
    off_limits: false,
    tags: [],
    general_email: null,
    last_activity_at: null,
    next_action_at: null,
    address_provider_place_id: null,
    address_provider: null,
    ...overrides,
  };
}

describe('company-workspace — relationship helpers (ADR-0032)', () => {
  it('companyTypes returns the distinct roles in canonical order', () => {
    const c = make({
      relationships: [rel({ type: 'VENDOR' }), rel({ type: 'CLIENT' })],
    });
    expect(companyTypes(c)).toEqual(['CLIENT', 'VENDOR']);
  });

  it('primaryStatus prefers CLIENT, then the first role', () => {
    expect(
      primaryStatus(
        make({
          relationships: [
            rel({ type: 'VENDOR', status: 'ON_HOLD' }),
            rel({ type: 'CLIENT', status: 'ACTIVE' }),
          ],
        }),
      ),
    ).toBe('ACTIVE');
    expect(
      primaryStatus(make({ relationships: [rel({ type: 'PARTNER', status: 'PROSPECT' })] })),
    ).toBe('PROSPECT');
    expect(primaryStatus(make({ relationships: [] }))).toBeNull();
  });

  it('labels map machine values to human text', () => {
    expect(relTypeLabel('CLIENT')).toBe('Client');
    expect(relTypeLabel('VENDOR')).toBe('Vendor');
    expect(relStatusLabel('ON_HOLD')).toBe('On hold');
    expect(relStatusLabel('PROSPECT')).toBe('Prospect');
  });
});

describe('company-workspace — facets over relationships (some-semantics)', () => {
  it('relationship_type facet passes when the company has that role', () => {
    const c = make({ relationships: [rel({ type: 'VENDOR' })] });
    expect(passesFacets(c, { ...EMPTY_FACETS, relationship_type: ['VENDOR'] })).toBe(true);
    expect(passesFacets(c, { ...EMPTY_FACETS, relationship_type: ['CLIENT'] })).toBe(false);
  });
  it('relationship_status facet passes when any relationship has that status', () => {
    const c = make({
      relationships: [rel({ type: 'CLIENT', status: 'ACTIVE' }), rel({ type: 'VENDOR', status: 'ON_HOLD' })],
    });
    expect(passesFacets(c, { ...EMPTY_FACETS, relationship_status: ['ON_HOLD'] })).toBe(true);
    expect(passesFacets(c, { ...EMPTY_FACETS, relationship_status: ['INACTIVE'] })).toBe(false);
  });
});

describe('company-workspace — buildCompanyQuery (tab + status)', () => {
  it('active tab → relationship_type param; status pills → relationship_status', () => {
    const p = buildCompanyQuery({
      scope: 'all',
      tab: 'VENDOR',
      facets: { ...EMPTY_FACETS, relationship_status: ['ACTIVE', 'ON_HOLD'] },
    });
    expect(p.get('relationship_type')).toBe('VENDOR');
    expect(p.get('relationship_status')).toBe('ACTIVE,ON_HOLD');
    expect(p.get('paged')).toBe('true');
  });
  it('all tab omits relationship_type; scope=mine sets scope', () => {
    const p = buildCompanyQuery({ scope: 'mine', tab: 'all', facets: EMPTY_FACETS });
    expect(p.get('relationship_type')).toBeNull();
    expect(p.get('scope')).toBe('mine');
  });
});

describe('company-workspace — tabCountFrom', () => {
  const facets = {
    relationship_type: [
      { value: 'CLIENT', count: 5 },
      { value: 'VENDOR', count: 2 },
    ],
    relationship_status: [],
    tier: [],
    industry: [],
    hot: 0,
    off_limits: 0,
    exclusivity: 0,
    quiet: 0,
  };
  it('all → total; a type tab → its bucket count; missing → 0', () => {
    expect(tabCountFrom(facets, 9, 'all')).toBe(9);
    expect(tabCountFrom(facets, 9, 'CLIENT')).toBe(5);
    expect(tabCountFrom(facets, 9, 'PARTNER')).toBe(0);
  });
  it('null facets → count only for all', () => {
    expect(tabCountFrom(null, 9, 'all')).toBe(9);
    expect(tabCountFrom(null, 9, 'CLIENT')).toBeNull();
  });
});

describe('company-workspace — retained helpers still honest', () => {
  it('tierLabel maps a|b|c and passes through null', () => {
    expect(tierLabel('a')).toBe('Key account');
    expect(tierLabel(null)).toBeNull();
  });
  it('inScope mine matches owner', () => {
    expect(inScope(make({ owner_id: 'u1' }), 'mine', 'u1')).toBe(true);
    expect(inScope(make({ owner_id: 'u2' }), 'mine', 'u1')).toBe(false);
    expect(inScope(make(), 'all', null)).toBe(true);
  });
  it('isQuiet true when never contacted; false when recent', () => {
    const now = Date.parse('2026-02-01T00:00:00Z');
    expect(isQuiet(make({ last_activity_at: null }), now)).toBe(true);
    expect(isQuiet(make({ last_activity_at: '2026-01-31T00:00:00Z' }), now)).toBe(false);
  });
  it('daysSinceContact + lastContactLabel', () => {
    const now = Date.parse('2026-01-10T00:00:00Z');
    expect(daysSinceContact(make({ last_activity_at: '2026-01-08T00:00:00Z' }), now)).toBe(2);
    expect(lastContactLabel(make({ last_activity_at: null }), now)).toBe('No contact');
  });
  it('matchesText over name/industry/location/tags', () => {
    expect(matchesText(make(), 'robot')).toBe(true);
    expect(matchesText(make(), 'zzz')).toBe(false);
  });
  it('deriveIndustries dedupes + sorts', () => {
    expect(
      deriveIndustries([make({ industry: 'B' }), make({ industry: 'A' }), make({ industry: 'A' })]),
    ).toEqual(['A', 'B']);
  });
});
