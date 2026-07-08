import { describe, expect, it } from 'vitest';
import { deriveSkillIdCanonical, validateClaimShape } from '@aramo/talent-trust';

import { mapSkillToClaim, mapWorkHistoryToClaim } from '../lib/ledger-mapper.js';
import { deriveSkillId } from '../lib/skill-id.js';

// TR-4 B2 (§5b) — the mapper conformance PROPERTY: every mapper output conforms
// to the T4-B1 registry, so the write gate provably never fires on this path;
// and deriveSkillId parity between the two homes (byte-identical).

describe('deriveSkillId parity (producer ↔ trust registry)', () => {
  it('is byte-identical across the two homes for a spread of surface forms', () => {
    for (const s of ['TypeScript', 'react.js', 'Go', 'AWS Lambda', '  Rust ', 'C++', 'node']) {
      expect(deriveSkillId(s)).toBe(deriveSkillIdCanonical(s));
    }
  });
});

describe('mapWorkHistoryToClaim — output always conforms (property)', () => {
  // A generative-style sweep: employer/title always present (NOT-NULL columns);
  // dates present/absent; employment_type present/absent/blank.
  const dates: Array<Date | null> = [
    null,
    new Date('2020-01-15T00:00:00.000Z'),
    new Date('2019-12-31T00:00:00.000Z'),
  ];
  const types: Array<string | null> = [null, '', 'full_time', 'Contract'];

  it('conforms to EMPLOYMENT for every typed-row combination (gate never fires)', () => {
    let n = 0;
    for (const start of dates) {
      for (const end of dates) {
        for (const t of types) {
          const claim = mapWorkHistoryToClaim({
            id: `00000000-0000-7000-8000-00000000000${n % 10}`,
            employer_name: 'Acme Inc.',
            role_title: 'Engineer',
            start_date: start,
            end_date: end,
            employment_type: t,
          });
          const r = validateClaimShape('EMPLOYMENT', claim.payload);
          expect(r.ok).toBe(true);
          // A present date → ISO; absent → null (never guessed).
          if (start !== null) expect(r.canonical?.['start_date']).toBe(start.toISOString().slice(0, 10));
          else expect(r.canonical?.['start_date']).toBeNull();
          expect(claim.source_ref.kind).toBe('work_history');
          n += 1;
        }
      }
    }
    expect(n).toBeGreaterThan(0);
  });

  it('carries the typed-row id as the source_ref provenance key', () => {
    const claim = mapWorkHistoryToClaim({
      id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      employer_name: 'Foo',
      role_title: 'Dev',
      start_date: null,
      end_date: null,
      employment_type: null,
    });
    expect(claim.source_ref).toEqual({
      talent_evidence_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      kind: 'work_history',
      store: 'talent_evidence',
    });
  });
});

describe('mapSkillToClaim — output always conforms; skill_id parity through the gate', () => {
  it('conforms to SKILL and the gate-derived skill_id equals the typed skill_id', () => {
    const claim = mapSkillToClaim({
      id: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
      surface_form: 'TypeScript',
      skill_id: deriveSkillId('TypeScript'),
    });
    const r = validateClaimShape('SKILL', claim.payload);
    expect(r.ok).toBe(true);
    // The gate derives skill_id from value_raw; parity → equals the typed row's.
    expect(r.canonical?.['skill_id']).toBe(deriveSkillId('TypeScript'));
    expect(claim.source_ref.kind).toBe('skill');
  });
});
