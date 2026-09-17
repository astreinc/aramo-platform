import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { deriveSkillIdCanonical, validateClaimShape } from '@aramo/talent-trust';

import {
  mapAssertionToClaim,
  mapCertificationToClaim,
  mapEducationToClaim,
  mapSkillToClaim,
  mapWorkAuthorizationToClaim,
  mapWorkHistoryToClaim,
} from '../lib/ledger-mapper.js';
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

// TR-7 B1 (§5b) — the DEGREE/CERTIFICATION mapper conformance property: institution
// + degree / name are NOT-NULL columns, so the required fields are ALWAYS present →
// the write gate never fires. Stored @db.Date → its ISO is the honest raw; absent
// dates omit the raw (the shape yields null). source_ref keys the typed row.
describe('mapEducationToClaim — output always conforms (property)', () => {
  const dates: Array<Date | null> = [null, new Date('2018-05-01T00:00:00.000Z')];
  const fields: Array<string | null> = [null, '', 'Computer Science'];

  it('conforms to DEGREE for every typed-row combination (gate never fires)', () => {
    let n = 0;
    for (const conferred of dates) {
      for (const field of fields) {
        const claim = mapEducationToClaim({
          id: `00000000-0000-7000-8000-0000000000e${n % 10}`,
          institution_name: 'MIT',
          degree_name: 'BSc',
          field_of_study: field,
          conferred_date: conferred,
        });
        const r = validateClaimShape('DEGREE', claim.payload);
        expect(r.ok).toBe(true);
        if (conferred !== null) {
          expect(r.canonical?.['conferred_date']).toBe(conferred.toISOString().slice(0, 10));
        } else {
          expect(r.canonical?.['conferred_date']).toBeNull();
        }
        expect(claim.assertion_type).toBe('DEGREE');
        expect(claim.source_ref.kind).toBe('education');
        n += 1;
      }
    }
    expect(n).toBeGreaterThan(0);
  });
});

// TALENT-INTEL-1 (TI-1C §step-4) — the work-authorization mapper: every typed
// TalentWorkAuthorization row maps to a RIGHT_TO_WORK claim whose payload
// conforms to the registry (the write gate provably never fires on this path).
// status + requires_sponsorship are NOT-NULL columns (always present); visa_type
// (nullable) and authorized_to_work_in (array) are carried only when present —
// never synthesized. source_ref keys the typed row for idempotent routing.
describe('mapWorkAuthorizationToClaim — output conforms to RIGHT_TO_WORK (property)', () => {
  it('conforms for every typed-row combination; keys source_ref by the row id', () => {
    const visas: Array<string | null> = [null, '', 'H-1B'];
    const arrays: string[][] = [[], ['US'], ['US', 'CA']];
    const sponsor = [true, false];
    let n = 0;
    for (const v of visas) {
      for (const a of arrays) {
        for (const s of sponsor) {
          const id = `00000000-0000-7000-8000-0000000000d${n % 10}`;
          const claim = mapWorkAuthorizationToClaim({
            id,
            work_authorization_status: 'VISA_HOLDER',
            authorized_to_work_in: a,
            visa_type: v,
            requires_sponsorship: s,
          });
          const r = validateClaimShape('RIGHT_TO_WORK', claim.payload);
          expect(r.ok).toBe(true);
          expect(claim.assertion_type).toBe('RIGHT_TO_WORK');
          expect(claim.source_ref.kind).toBe('work_authorization');
          expect(claim.source_ref.talent_evidence_id).toBe(id);
          expect(r.canonical?.['work_authorization_status_raw']).toBe('VISA_HOLDER');
          expect(r.canonical?.['requires_sponsorship']).toBe(s);
          n += 1;
        }
      }
    }
    expect(n).toBe(18);
  });
});

describe('mapCertificationToClaim — output always conforms (property)', () => {
  const dates: Array<Date | null> = [null, new Date('2021-03-10T00:00:00.000Z')];
  const opt: Array<string | null> = [null, '', 'AWS'];

  it('conforms to CERTIFICATION for every typed-row combination (gate never fires)', () => {
    let n = 0;
    for (const issued of dates) {
      for (const expiry of dates) {
        for (const o of opt) {
          const claim = mapCertificationToClaim({
            id: `00000000-0000-7000-8000-0000000000c${n % 10}`,
            certification_name: 'CKA',
            issuer_name: o,
            credential_ref: o,
            issued_date: issued,
            expiry_date: expiry,
          });
          const r = validateClaimShape('CERTIFICATION', claim.payload);
          expect(r.ok).toBe(true);
          if (issued !== null) {
            expect(r.canonical?.['issued_date']).toBe(issued.toISOString().slice(0, 10));
          } else {
            expect(r.canonical?.['issued_date']).toBeNull();
          }
          expect(claim.assertion_type).toBe('CERTIFICATION');
          expect(claim.source_ref.kind).toBe('certification');
          n += 1;
        }
      }
    }
    expect(n).toBeGreaterThan(0);
  });
});

// TR-7 D1 (§5d) — the negative ruling, STRUCTURAL: the producer reads résumé-
// extraction rows only; NO import path or call from examination results to the
// trust ledger, in this arc or by drift. Comments are stripped before matching
// (prose may name 'examination' when describing the boundary).
describe('D1 — the producer never reads examination results (structural)', () => {
  const strip = (raw: string): string =>
    raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');

  const files = ['../lib/talent-extraction.service.ts', '../lib/ledger-mapper.ts'];

  it('HF2 mapAssertionToClaim → EXPERIENCE_CLAIM conforms to the T4-B1 shape + carries grounding_class', () => {
    const claim = mapAssertionToClaim(
      { type: 'DEVELOP', statement: 'Built Java services', metric: '40%', grounding_class: 'SOURCE_ASSOCIATED_INTERPRETATION' },
      'we-123',
    );
    expect(claim.assertion_type).toBe('EXPERIENCE_CLAIM');
    expect(claim.source_ref.kind).toBe('experience_claim');
    expect(claim.source_ref.store).toBe('resume_extraction');
    // Output conforms to the trust write-gate shape (never fires on this path).
    const v = validateClaimShape('EXPERIENCE_CLAIM', claim.payload);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.canonical['grounding_class']).toBe('SOURCE_ASSOCIATED_INTERPRETATION');
      expect(v.canonical['work_experience_ref']).toBe('we-123');
      expect(v.canonical['metric_raw']).toBe('40%');
    }
  });

  it('HF2 mapAssertionToClaim source_ref key is DETERMINISTIC (idempotent re-create)', () => {
    const a = { type: 'DEPLOY', statement: 'Deployed to EKS' };
    const k1 = mapAssertionToClaim(a, 'we-1').source_ref.talent_evidence_id;
    const k2 = mapAssertionToClaim(a, 'we-1').source_ref.talent_evidence_id;
    const k3 = mapAssertionToClaim(a, 'we-2').source_ref.talent_evidence_id; // different role
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('imports and names no examination substrate', () => {
    for (const rel of files) {
      const code = strip(readFileSync(resolve(__dirname, rel), 'utf8'));
      // The examination-substrate tokens: an import edge or a named read of the
      // snapshot. Their absence IS the D1 negative ruling (the producer reads
      // résumé-extraction rows only, never an examination result).
      for (const token of [
        '@aramo/examination',
        'TalentJobExamination',
        'ExaminationRepository',
        'examination',
      ]) {
        expect(code).not.toContain(token);
      }
    }
  });
});
