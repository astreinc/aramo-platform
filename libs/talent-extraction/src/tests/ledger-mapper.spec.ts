import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { deriveSkillIdCanonical, validateClaimShape } from '@aramo/talent-trust';

import {
  mapCertificationToClaim,
  mapEducationToClaim,
  mapSkillToClaim,
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
