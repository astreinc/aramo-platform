import { describe, expect, it } from 'vitest';

import {
  EMPTY_FACETS,
  buildTalentQuery,
  deriveSkillCounts,
  parseQuery,
  skillsOf,
  type FacetState,
  type ParsedQuery,
  type TalentQueryInput,
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
    work_authorization: null,
    date_available: null,
    can_relocate: false,
    is_hot: false,
    notes: null,
    web_site: null,
    best_time_to_call: null,
    owner_id: null,
    entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...o,
  };
}

const facets = (o: Partial<FacetState> = {}): FacetState => ({ ...EMPTY_FACETS, ...o });
const noQuery: ParsedQuery = { tokens: [], free: '' };
const baseInput = (o: Partial<TalentQueryInput> = {}): TalentQueryInput => ({
  facets: facets(),
  query: noQuery,
  scope: 'all',
  view: 'all',
  sort: 'name',
  dir: 'asc',
  cursor: null,
  sessionSub: 'me',
  ...o,
});

describe('parseQuery', () => {
  it('splits supported tokens (name/skill/loc) from free text', () => {
    const p = parseQuery('skill:Rust loc:austin name:ada senior eng');
    expect(p.tokens).toEqual([
      { key: 'skill', value: 'Rust', supported: true },
      { key: 'loc', value: 'austin', supported: true },
      { key: 'name', value: 'ada', supported: true },
    ]);
    expect(p.free).toBe('senior eng');
  });
  it('marks unknown/unbackable keys (status:/intouch:/owner:) as unsupported', () => {
    const p = parseQuery('status:active intouch:6mo owner:tom');
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

describe('deriveSkillCounts (within-loaded — the one remaining client count)', () => {
  it('tallies skills across the loaded set, most-frequent first', () => {
    const counts = deriveSkillCounts([
      t('1', 'A', 'A', { key_skills: 'Rust, Go' }),
      t('2', 'B', 'B', { key_skills: 'Rust, AWS' }),
      t('3', 'C', 'C', { key_skills: 'Go' }),
    ]);
    expect(counts.find((s) => s.value === 'Rust')?.count).toBe(2);
    expect(counts.find((s) => s.value === 'Go')?.count).toBe(2);
    expect(counts.find((s) => s.value === 'AWS')?.count).toBe(1);
  });
});

describe('buildTalentQuery — UI state → ?paged=true server query', () => {
  it('always sends paged=true + sort/dir', () => {
    const p = buildTalentQuery(baseInput());
    expect(p.get('paged')).toBe('true');
    expect(p.get('sort')).toBe('name');
    expect(p.get('dir')).toBe('asc');
  });

  it('maps name: tokens + free text into q', () => {
    const p = buildTalentQuery(
      baseInput({
        query: { tokens: [{ key: 'name', value: 'ada', supported: true }], free: 'senior' },
      }),
    );
    expect(p.get('q')).toBe('ada senior');
  });

  it('maps the skills facet + skill: tokens into skills + skill_match', () => {
    const p = buildTalentQuery(
      baseInput({
        facets: facets({ skills: ['Rust'], skillMatch: 'all' }),
        query: { tokens: [{ key: 'skill', value: 'Go', supported: true }], free: '' },
      }),
    );
    expect(p.get('skills')).toBe('Rust,Go');
    expect(p.get('skill_match')).toBe('all');
  });

  it('maps availability / engagement / source / hot / location', () => {
    const p = buildTalentQuery(
      baseInput({
        facets: facets({
          availability: ['available_now'],
          engagementTypes: ['contract'],
          sources: ['Referral'],
          hotOnly: true,
          location: 'Austin',
        }),
      }),
    );
    expect(p.get('availability')).toBe('available_now');
    expect(p.get('engagement')).toBe('contract');
    expect(p.get('source')).toBe('Referral');
    expect(p.get('hot')).toBe('true');
    expect(p.get('location')).toBe('Austin');
  });

  it('CRM-2 scope=working_with_me → ?scope=working_with_me (NO owner_id); scope=all → neither', () => {
    const wwm = buildTalentQuery(baseInput({ scope: 'working_with_me' }));
    expect(wwm.get('scope')).toBe('working_with_me');
    expect(wwm.get('owner')).toBeNull(); // owner_id is NEVER sent as scope
    const all = buildTalentQuery(baseInput({ scope: 'all' }));
    expect(all.get('owner')).toBeNull();
    expect(all.get('scope')).toBeNull();
  });

  it('Available-now view is NATIVE — folds into availability, sends NO preset param', () => {
    const p = buildTalentQuery(baseInput({ view: 'available_now' }));
    expect(p.get('availability')).toBe('available_now');
    expect(p.get('preset')).toBeNull();
  });

  it('CRM-2 Follow-up due (needs_follow_up) sends the preset param; it is the only cross-schema quick filter', () => {
    expect(
      buildTalentQuery(baseInput({ view: 'needs_follow_up' })).get('preset'),
    ).toBe('needs_follow_up');
  });

  it("the 'all' view adds neither availability nor a preset param", () => {
    const p = buildTalentQuery(baseInput({ view: 'all' }));
    expect(p.get('preset')).toBeNull();
    expect(p.get('availability')).toBeNull();
    expect(p.get('hot')).toBeNull();
  });

  it('passes the keyset cursor + page_size when present', () => {
    const p = buildTalentQuery(baseInput({ cursor: 'abc', pageSize: 25 }));
    expect(p.get('cursor')).toBe('abc');
    expect(p.get('page_size')).toBe('25');
  });
});
