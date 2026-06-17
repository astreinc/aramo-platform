import { describe, expect, it } from 'vitest';

import type { CompanyView } from './types';
import {
  EMPTY_FACETS,
  daysSinceContact,
  deriveIndustries,
  inScope,
  inSegment,
  isQuiet,
  lastContactLabel,
  matchesText,
  passesFacets,
  relationshipLabel,
  tierLabel,
} from './company-workspace';

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

const NOW = Date.UTC(2026, 5, 16); // 2026-06-16

describe('company-workspace mappers', () => {
  it('maps status → relationship label', () => {
    expect(relationshipLabel('active')).toBe('Client');
    expect(relationshipLabel('prospect')).toBe('Prospect');
    expect(relationshipLabel('inactive')).toBe('Dormant');
    expect(relationshipLabel('do_not_contact')).toBe('Do not contact');
    expect(relationshipLabel('weird')).toBe('weird');
  });

  it('maps client_tier a|b|c → tier label (null → null)', () => {
    expect(tierLabel('a')).toBe('Key account');
    expect(tierLabel('b')).toBe('Growth');
    expect(tierLabel('c')).toBe('Standard');
    expect(tierLabel(null)).toBeNull();
    expect(tierLabel('')).toBeNull();
  });
});

describe('quiet / last-contact derivation', () => {
  it('treats never-contacted as quiet', () => {
    const c = make({ last_activity_at: null });
    expect(daysSinceContact(c, NOW)).toBeNull();
    expect(isQuiet(c, NOW)).toBe(true);
    expect(lastContactLabel(c, NOW)).toBe('No contact');
  });

  it('is quiet only past 30 days', () => {
    const recent = make({ last_activity_at: '2026-06-10T00:00:00Z' });
    const stale = make({ last_activity_at: '2026-04-01T00:00:00Z' });
    expect(isQuiet(recent, NOW)).toBe(false);
    expect(isQuiet(stale, NOW)).toBe(true);
  });

  it('formats relative last-contact', () => {
    expect(lastContactLabel(make({ last_activity_at: '2026-06-16T00:00:00Z' }), NOW)).toBe(
      'today',
    );
    expect(lastContactLabel(make({ last_activity_at: '2026-06-15T00:00:00Z' }), NOW)).toBe(
      'yesterday',
    );
    expect(lastContactLabel(make({ last_activity_at: '2026-06-12T00:00:00Z' }), NOW)).toBe(
      '4d ago',
    );
  });
});

describe('scope / segment filtering', () => {
  it('scope mine matches owner; all matches everything', () => {
    const mine = make({ owner_id: 'u1' });
    const other = make({ owner_id: 'u2' });
    expect(inScope(mine, 'mine', 'u1')).toBe(true);
    expect(inScope(other, 'mine', 'u1')).toBe(false);
    expect(inScope(other, 'all', 'u1')).toBe(true);
    expect(inScope(mine, 'mine', null)).toBe(false);
  });

  it('segments bind to real fields', () => {
    const key = make({ client_tier: 'a' });
    const prospect = make({ status: 'prospect' });
    const hot = make({ is_hot: true });
    const quiet = make({ last_activity_at: '2026-01-01T00:00:00Z' });
    expect(inSegment(key, 'key')).toBe(true);
    expect(inSegment(make({ client_tier: 'b' }), 'key')).toBe(false);
    expect(inSegment(prospect, 'prospects')).toBe(true);
    expect(inSegment(hot, 'hot')).toBe(true);
    expect(inSegment(quiet, 'quiet', NOW)).toBe(true);
    expect(inSegment(make(), 'all')).toBe(true);
  });
});

describe('facets + text', () => {
  it('empty facets pass everything', () => {
    expect(passesFacets(make(), EMPTY_FACETS)).toBe(true);
  });

  it('AND across groups, OR within a group', () => {
    const c = make({ status: 'active', client_tier: 'a', industry: 'Robotics' });
    expect(
      passesFacets(c, { ...EMPTY_FACETS, relationship: ['active', 'prospect'] }),
    ).toBe(true);
    expect(passesFacets(c, { ...EMPTY_FACETS, relationship: ['prospect'] })).toBe(
      false,
    );
    expect(
      passesFacets(c, { ...EMPTY_FACETS, tier: ['a'], industry: ['Robotics'] }),
    ).toBe(true);
    expect(
      passesFacets(c, { ...EMPTY_FACETS, tier: ['a'], industry: ['Energy'] }),
    ).toBe(false);
  });

  it('flag facets bind to fields', () => {
    expect(passesFacets(make({ is_hot: true }), { ...EMPTY_FACETS, flags: ['hot'] })).toBe(
      true,
    );
    expect(passesFacets(make({ exclusivity: true }), { ...EMPTY_FACETS, flags: ['exclusive'] })).toBe(
      true,
    );
    expect(
      passesFacets(make({ off_limits: true }), { ...EMPTY_FACETS, flags: ['off_limits'] }),
    ).toBe(true);
    expect(passesFacets(make({ off_limits: false }), { ...EMPTY_FACETS, flags: ['off_limits'] })).toBe(
      false,
    );
  });

  it('text matches name / industry / location / tags', () => {
    const c = make({ name: 'Northwind', industry: 'Robotics', city: 'Austin', tags: ['Rust'] });
    expect(matchesText(c, '')).toBe(true);
    expect(matchesText(c, 'north')).toBe(true);
    expect(matchesText(c, 'robot')).toBe(true);
    expect(matchesText(c, 'austin')).toBe(true);
    expect(matchesText(c, 'rust')).toBe(true);
    expect(matchesText(c, 'zzz')).toBe(false);
  });

  it('derives sorted unique industries', () => {
    const list = [make({ industry: 'SaaS' }), make({ industry: 'Robotics' }), make({ industry: 'SaaS' }), make({ industry: null })];
    expect(deriveIndustries(list)).toEqual(['Robotics', 'SaaS']);
  });
});
