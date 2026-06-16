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

const facets = (o: Partial<FacetState> = {}): FacetState => ({ ...EMPTY_FACETS, ...o });
const noQuery: ParsedQuery = { tokens: [], free: '' };
const baseInput = (o: Partial<TalentQueryInput> = {}): TalentQueryInput => ({
  facets: facets(),
  query: noQuery,
  scope: 'all',
  preset: null,
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

  it('scope=mine → owner=<me>; scope=team → scope=my_team; scope=all → neither', () => {
    expect(buildTalentQuery(baseInput({ scope: 'mine' })).get('owner')).toBe('me');
    const team = buildTalentQuery(baseInput({ scope: 'team' }));
    expect(team.get('scope')).toBe('my_team');
    expect(team.get('owner')).toBeNull();
    const all = buildTalentQuery(baseInput({ scope: 'all' }));
    expect(all.get('owner')).toBeNull();
    expect(all.get('scope')).toBeNull();
  });

  it('Available-now preset is NATIVE — folds into availability, sends NO preset param', () => {
    const p = buildTalentQuery(baseInput({ preset: 'available_now' }));
    expect(p.get('availability')).toBe('available_now');
    expect(p.get('preset')).toBeNull();
  });

  it('cross-schema presets send the preset param', () => {
    expect(buildTalentQuery(baseInput({ preset: 'in_touch_6mo' })).get('preset')).toBe(
      'in_touch_6mo',
    );
    expect(
      buildTalentQuery(baseInput({ preset: 'submitted_this_week' })).get('preset'),
    ).toBe('submitted_this_week');
    expect(
      buildTalentQuery(baseInput({ preset: 'needs_follow_up' })).get('preset'),
    ).toBe('needs_follow_up');
  });

  it('passes the keyset cursor + page_size when present', () => {
    const p = buildTalentQuery(baseInput({ cursor: 'abc', pageSize: 25 }));
    expect(p.get('cursor')).toBe('abc');
    expect(p.get('page_size')).toBe('25');
  });
});
