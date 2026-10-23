import { describe, expect, it } from 'vitest';
import type { IntelligenceProfileReadResponse, ResolvedFactView } from '@aramo/intelligence-contracts';

import {
  DEFAULT_INTELLIGENCE_SYNC_POLICY,
  INTELLIGENCE_SYNC_FIELD_KEYS,
  decideField,
  effectiveMode,
  fieldKeysOfColumns,
  proposalsFromProfile,
  type AtsCurrentState,
  type FieldControl,
} from '../lib/sync-policy.js';

// ATI-SEP-1 T8 — the inbound sync policy + decision matrix (pure).

const MANUAL: FieldControl = { value_state: 'SET', source_type: 'MANUAL', projection_policy: 'AUTO' };
const HOLD: FieldControl = { value_state: 'SET', source_type: 'RECONCILED', projection_policy: 'HOLD' };
const CLEARED: FieldControl = { value_state: 'EXPLICITLY_CLEARED', source_type: 'MANUAL', projection_policy: 'HOLD' };
const MACHINE: FieldControl = { value_state: 'SET', source_type: 'RECONCILED', projection_policy: 'AUTO' };

describe('ATI-SEP-1 T8 — default policy (conservative)', () => {
  it('everything REVIEW except availability AUTO_APPLY and contacts IGNORE', () => {
    for (const k of INTELLIGENCE_SYNC_FIELD_KEYS) {
      const expected = k === 'availability' ? 'AUTO_APPLY' : k === 'contacts' ? 'IGNORE' : 'REVIEW';
      expect(DEFAULT_INTELLIGENCE_SYNC_POLICY[k], k).toBe(expected);
    }
  });
  it('AUTO_APPLY is clamped to REVIEW where the ATS has no automatic write path', () => {
    for (const k of ['work_authorization', 'work_history', 'education', 'certifications', 'projects'] as const) {
      expect(effectiveMode(k, 'AUTO_APPLY')).toBe('REVIEW');
    }
    expect(effectiveMode('title', 'AUTO_APPLY')).toBe('AUTO_APPLY');
    expect(effectiveMode('title')).toBe('REVIEW');
    expect(effectiveMode('contacts')).toBe('IGNORE');
  });
  it('maps INTELLIGENCE provenance columns back to field keys', () => {
    expect([...fieldKeysOfColumns(['city', 'availability_status', 'web_site', 'unknown_col'])].sort()).toEqual(['availability', 'location', 'public_profile_url']);
  });
});

describe('ATI-SEP-1 T8 — decision matrix', () => {
  const rows: Array<[string, Parameters<typeof decideField>[0], string]> = [
    ['IGNORE always ignores', { mode: 'IGNORE', ats_empty: true, controls: [], writable: true }, 'IGNORE'],
    ['REVIEW never writes, even an empty field', { mode: 'REVIEW', ats_empty: true, controls: [], writable: true }, 'REVIEW'],
    ['AUTO_APPLY fills an EMPTY field', { mode: 'AUTO_APPLY', ats_empty: true, controls: [undefined], writable: true }, 'APPLY'],
    ['AUTO_APPLY never over a recruiter MANUAL value', { mode: 'AUTO_APPLY', ats_empty: false, controls: [MANUAL], writable: true }, 'REVIEW'],
    ['AUTO_APPLY never into a HOLD field, even empty', { mode: 'AUTO_APPLY', ats_empty: true, controls: [HOLD], writable: true }, 'REVIEW'],
    ['AUTO_APPLY never refills an EXPLICITLY_CLEARED field', { mode: 'AUTO_APPLY', ats_empty: true, controls: [CLEARED], writable: true }, 'REVIEW'],
    ['AUTO_APPLY over a provably machine-sourced value', { mode: 'AUTO_APPLY', ats_empty: false, controls: [MACHINE], writable: true }, 'APPLY'],
    ['AUTO_APPLY over a value with NO control row → treated as recruiter-entered', { mode: 'AUTO_APPLY', ats_empty: false, controls: [undefined], writable: true }, 'REVIEW'],
    ['one recruiter-confirmed column blocks the whole field', { mode: 'AUTO_APPLY', ats_empty: false, controls: [MACHINE, MANUAL], writable: true }, 'REVIEW'],
    ['AUTO_APPLY with no writable column → REVIEW', { mode: 'AUTO_APPLY', ats_empty: true, controls: [], writable: false }, 'REVIEW'],
  ];
  for (const [name, input, expected] of rows) {
    it(name, () => expect(decideField(input)).toBe(expected));
  }
});

function fact(fact_type: ResolvedFactView['fact_type'], value: Record<string, unknown>, state: ResolvedFactView['state'] = 'RESOLVED', fact_key = ''): ResolvedFactView {
  return { fact_type, fact_key, value, state, verification_status: 'DECLARED', corroborating_sources: 1, supporting_assertion_ids: [] };
}

function profile(facts: ResolvedFactView[]): IntelligenceProfileReadResponse {
  return {
    intelligence_subject_id: '33333333-3333-7333-8333-333333333333',
    access_mode: 'TENANT_SCOPED',
    facts,
    trust: {} as never,
    generated_at: '2026-10-23T00:00:00.000Z',
  };
}

const ATS: AtsCurrentState = {
  values: { first_name: 'Ada', last_name: 'Lovelace', email1: 'ada@example.com', phone_cell: null, city: 'Austin', state: 'TX', country: 'US', current_employer: 'Acme', title: null, web_site: null, key_skills: 'SQL, Go', availability_status: null, date_available: null },
  email2: null,
  phones: [],
  work_authorization: 'US_CITIZEN',
  skill_names: ['Rust'],
  employer_names: ['Acme'],
  institution_names: [],
  certification_names: [],
  project_names: [],
};

describe('ATI-SEP-1 T8 — proposalsFromProfile', () => {
  it('a fact EQUAL to the ATS value is no change (tenant-scoped echoes produce nothing)', () => {
    const p = proposalsFromProfile(
      profile([
        fact('NAME', { first: 'Ada', last: 'Lovelace' }),
        fact('CURRENT_EMPLOYER', { name: 'acme' }),
        fact('LOCATION', { city: 'Austin', region: 'TX', country: 'US' }),
        fact('SKILL', { name: 'sql' }, 'RESOLVED', 'sql'),
        fact('SKILL', { name: 'Rust' }, 'RESOLVED', 'rust'),
        fact('WORK_HISTORY', { employer: 'Acme' }),
        fact('WORK_AUTHORIZATION', { status: 'CITIZEN', jurisdiction: 'US' }),
        fact('EMAIL', { value: 'ADA@example.com' }),
      ]),
      ATS,
    );
    expect(p).toEqual([]);
  });

  it('differing / new facts become proposals with the ATS columns they would write', () => {
    const p = proposalsFromProfile(
      profile([
        fact('TITLE', { value: 'Principal Engineer' }),
        fact('AVAILABILITY', { status: 'AVAILABLE', date_available: '2026-11-01', freshness: 'CURRENT' }),
        fact('SKILL', { name: 'Kotlin' }, 'RESOLVED', 'kotlin'),
        fact('EDUCATION', { institution: 'University of London' }),
        fact('PHONE', { value: '+1 555 000 1111' }),
        fact('CURRENT_EMPLOYER', { name: 'Globex' }, 'CONTRADICTED'),
      ]),
      ATS,
    );
    const by = Object.fromEntries(p.map((x) => [x.field_key, x]));
    expect(by['title']).toMatchObject({ field_name: 'title', columns: { title: 'Principal Engineer' }, ats_empty: true });
    expect(by['availability']).toMatchObject({ field_name: 'availability_status', columns: { availability_status: 'available_now', date_available: new Date('2026-11-01T00:00:00.000Z') }, ats_empty: true });
    expect(by['skills']).toMatchObject({ field_name: 'key_skills', display: 'Kotlin', ats_empty: false });
    expect(by['education']).toMatchObject({ field_name: 'education', columns: {}, display: 'University of London' });
    expect(by['contacts']).toMatchObject({ field_name: 'phone_cell', columns: { phone_cell: '+1 555 000 1111' }, ats_empty: true });
    // A CONTRADICTED fact is never proposed.
    expect(by['current_employer']).toBeUndefined();
  });
});
