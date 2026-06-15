import { describe, expect, it } from 'vitest';

import {
  EMPTY_FACETS,
  applyFilters,
  applyView,
  deriveFacets,
  parseQuery,
  skillsOf,
  sortTalent,
  type FacetState,
} from './talent-workspace';
import type { TalentRecordView } from './types';

function t(
  id: string,
  first: string,
  last: string,
  o: Partial<TalentRecordView> = {},
): TalentRecordView {
  return {
    id,
    tenant_id: 't',
    site_id: null,
    first_name: first,
    last_name: last,
    email1: null,
    email2: null,
    phone_home: null,
    phone_cell: null,
    phone_work: null,
    address: null,
    address2: null,
    city: null,
    state: null,
    zip: null,
    source: null,
    key_skills: null,
    current_employer: null,
    current_pay: null,
    desired_pay: null,
    availability_status: null,
    engagement_type: null,
    date_available: null,
    can_relocate: false,
    is_hot: false,
    notes: null,
    web_site: null,
    best_time_to_call: null,
    owner_id: null,
    entered_by_id: null,
    core_talent_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...o,
  };
}

const POOL: TalentRecordView[] = [
  t('1', 'Ada', 'Lovelace', { key_skills: 'Rust, Go', city: 'Austin', state: 'TX', source: 'Referral', is_hot: true, owner_id: 'me' }),
  t('2', 'Bob', 'Khan', { key_skills: 'Rust, AWS', city: 'Seattle', state: 'WA', source: 'Import', owner_id: 'other' }),
  t('3', 'Cy', 'Park', { key_skills: 'Go', city: 'Austin', state: 'TX', source: 'Referral' }),
];

const base = (o: Partial<FacetState> = {}): FacetState => ({ ...EMPTY_FACETS, ...o });
const noQuery = { tokens: [], free: '' };

describe('parseQuery', () => {
  it('splits supported tokens from free text', () => {
    const p = parseQuery('skill:Rust loc:austin senior eng');
    expect(p.tokens).toEqual([
      { key: 'skill', value: 'Rust', supported: true },
      { key: 'loc', value: 'austin', supported: true },
    ]);
    expect(p.free).toBe('senior eng');
  });
  it('marks unknown grammar keys (status:/intouch:) as unsupported, non-filtering', () => {
    const p = parseQuery('status:active intouch:6mo');
    expect(p.tokens.every((x) => !x.supported)).toBe(true);
  });
  it('treats a bare colon-less word as free text', () => {
    expect(parseQuery('rust').free).toBe('rust');
  });
});

describe('skillsOf', () => {
  it('splits the free-text key_skills on commas', () => {
    expect(skillsOf(t('x', 'A', 'B', { key_skills: 'Rust, Go ,  AWS' }))).toEqual([
      'Rust',
      'Go',
      'AWS',
    ]);
  });
});

describe('deriveFacets', () => {
  it('counts skills/sources/hot within the loaded set only', () => {
    const d = deriveFacets(POOL);
    expect(d.skills.find((s) => s.value === 'Rust')?.count).toBe(2);
    expect(d.skills.find((s) => s.value === 'Go')?.count).toBe(2);
    expect(d.sources.find((s) => s.value === 'Referral')?.count).toBe(2);
    expect(d.hot).toBe(1);
  });
});

describe('applyFilters', () => {
  const ctx = { scope: 'all' as const, sessionSub: 'me', ownerNames: {} };

  it('match-any skill OR, match-all skill AND', () => {
    const any = applyFilters(POOL, { ...ctx, facets: base({ skills: ['Rust', 'Go'], skillMatch: 'any' }), query: noQuery });
    expect(any.map((x) => x.id).sort()).toEqual(['1', '2', '3']);
    const all = applyFilters(POOL, { ...ctx, facets: base({ skills: ['Rust', 'Go'], skillMatch: 'all' }), query: noQuery });
    expect(all.map((x) => x.id)).toEqual(['1']);
  });

  it('hot-only + source + location facets', () => {
    expect(applyFilters(POOL, { ...ctx, facets: base({ hotOnly: true }), query: noQuery }).map((x) => x.id)).toEqual(['1']);
    expect(applyFilters(POOL, { ...ctx, facets: base({ sources: ['Import'] }), query: noQuery }).map((x) => x.id)).toEqual(['2']);
    expect(applyFilters(POOL, { ...ctx, facets: base({ location: 'austin' }), query: noQuery }).map((x) => x.id).sort()).toEqual(['1', '3']);
  });

  it('scope=mine filters to the actor-owned rows', () => {
    expect(applyFilters(POOL, { ...ctx, scope: 'mine', facets: base(), query: noQuery }).map((x) => x.id)).toEqual(['1']);
  });

  it('token skill: filters; unsupported token does NOT filter', () => {
    const tok = applyFilters(POOL, { ...ctx, facets: base(), query: { tokens: [{ key: 'skill', value: 'aws', supported: true }], free: '' } });
    expect(tok.map((x) => x.id)).toEqual(['2']);
    const stub = applyFilters(POOL, { ...ctx, facets: base(), query: { tokens: [{ key: 'status', value: 'active', supported: false }], free: '' } });
    expect(stub.length).toBe(3); // unsupported = no-op
  });
});

describe('stated-field facets (availability / engagement)', () => {
  const ctx = { scope: 'all' as const, sessionSub: 'me', ownerNames: {} };
  const POOL2: TalentRecordView[] = [
    t('1', 'A', 'A', { availability_status: 'available_now', engagement_type: 'contract' }),
    t('2', 'B', 'B', { availability_status: 'unknown', engagement_type: 'direct_hire' }),
    t('3', 'C', 'C', { availability_status: null, engagement_type: null }), // null avail → Unknown bucket
  ];

  it('derives availability (null collapses into the unknown bucket) + engagement counts', () => {
    const d = deriveFacets(POOL2);
    expect(d.availability.find((x) => x.value === 'available_now')?.count).toBe(1);
    expect(d.availability.find((x) => x.value === 'unknown')?.count).toBe(2); // explicit + null
    expect(d.engagement.find((x) => x.value === 'contract')?.count).toBe(1);
    expect(d.engagement.length).toBe(2); // null engagement not counted
  });

  it('availability "unknown" filter matches BOTH null and explicit unknown', () => {
    const r = applyFilters(POOL2, {
      ...ctx,
      facets: base({ availability: ['unknown'] }),
      query: noQuery,
    });
    expect(r.map((x) => x.id).sort()).toEqual(['2', '3']);
  });

  it('engagement filter excludes not-stated (null) rows', () => {
    const r = applyFilters(POOL2, {
      ...ctx,
      facets: base({ engagementTypes: ['contract'] }),
      query: noQuery,
    });
    expect(r.map((x) => x.id)).toEqual(['1']);
  });
});

describe('applyView', () => {
  it('mine / hot views; all falls back to the pool', () => {
    expect(applyView('mine', POOL, 'me').map((x) => x.id)).toEqual(['1']);
    expect(applyView('hot', POOL, 'me').map((x) => x.id)).toEqual(['1']);
    expect(applyView('all', POOL, 'me').length).toBe(3);
  });
});

describe('sortTalent', () => {
  it('sorts by name asc/desc', () => {
    expect(sortTalent(POOL, 'name', 'asc').map((x) => x.first_name)).toEqual(['Ada', 'Bob', 'Cy']);
    expect(sortTalent(POOL, 'name', 'desc').map((x) => x.first_name)).toEqual(['Cy', 'Bob', 'Ada']);
  });
  it('sorts by location and by resolved owner name', () => {
    // Austin, Austin, Seattle → asc puts Austin rows first
    expect(sortTalent(POOL, 'location', 'asc').map((x) => x.id)).toEqual(['1', '3', '2']);
    // owner: id 1 → "Priya", id 2 → "Tom", id 3 → unowned (sorts last asc)
    const names = { me: 'Priya', other: 'Tom' };
    expect(sortTalent(POOL, 'owner', 'asc', names).map((x) => x.id)).toEqual(['1', '2', '3']);
  });
});
