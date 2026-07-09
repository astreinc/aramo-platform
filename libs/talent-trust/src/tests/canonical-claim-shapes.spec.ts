import { describe, expect, it } from 'vitest';

import {
  CANONICAL_CLAIM_SHAPES,
  deriveSkillIdCanonical,
  isRegisteredAssertionType,
  parseToIsoDateOrNull,
  validateClaimShape,
} from '../lib/canonical-claim-shapes.js';

// TR-4 B1 (§5 a/b) — the canonical claim-shape registry, pure. Proves the
// registered/unregistered posture, the never-guessed date table, employer
// equality-normalization, and the deterministic skill_id.

describe('validateClaimShape — registered vs unregistered posture (§5a)', () => {
  it('a REGISTERED type with a canonical payload validates + normalizes', () => {
    const r = validateClaimShape('EMPLOYMENT', {
      employer_raw: '  Acme Inc.  ',
      role_title_raw: 'Engineer',
      start_date_raw: '2020-01',
      end_date_raw: 'Mar 2022',
    });
    expect(r.ok).toBe(true);
    expect(r.canonical).toMatchObject({
      employer_raw: 'Acme Inc.',
      employer_norm: 'acme',
      role_title_raw: 'Engineer',
      start_date: '2020-01-01',
      end_date: '2022-03-01',
      start_date_raw: '2020-01',
      end_date_raw: 'Mar 2022',
    });
  });

  it('a REGISTERED type with a malformed payload refuses (ok:false + errors)', () => {
    const r = validateClaimShape('EMPLOYMENT', { role_title_raw: 'Engineer' }); // no employer_raw
    expect(r.ok).toBe(false);
    expect(r.errors?.join(' ')).toMatch(/employer_raw/);
  });

  it('an UNREGISTERED type with any object passes through untouched (admission open)', () => {
    expect(isRegisteredAssertionType('DEGREE')).toBe(false);
    const payload = { anything: 'goes', nested: { x: 1 } };
    const r = validateClaimShape('DEGREE', payload);
    expect(r.ok).toBe(true);
    expect(r.canonical).toEqual(payload);
  });

  it('the registry membership IS the registered predicate', () => {
    expect(Object.keys(CANONICAL_CLAIM_SHAPES).sort()).toEqual([
      'EMAIL',
      'EMPLOYMENT',
      // TR-5 B2 — the positive CONTINUITY derivers' comparability shapes (NOT in
      // AUTHORITATIVE_ASSERTION_TYPES.CONTINUITY, which stays empty).
      'HISTORY_SPAN',
      'LONGITUDINAL_PRESENCE',
      'PHONE',
      'PROFILE_URL',
      'SKILL',
      // TR-4 B3 — the consistency detector's CONTINUITY gap signal.
      'TIMELINE_GAP',
    ]);
  });
});

describe('parseToIsoDateOrNull — deterministic, NEVER guessed (§5b)', () => {
  it('normalizes the parse-table formats', () => {
    expect(parseToIsoDateOrNull('2020-05-14')).toBe('2020-05-14');
    expect(parseToIsoDateOrNull('2020-05-14T09:30:00Z')).toBe('2020-05-14');
    expect(parseToIsoDateOrNull('2020-05')).toBe('2020-05-01');
    expect(parseToIsoDateOrNull('05/2020')).toBe('2020-05-01');
    expect(parseToIsoDateOrNull('2020')).toBe('2020-01-01');
    expect(parseToIsoDateOrNull('Jan 2020')).toBe('2020-01-01');
    expect(parseToIsoDateOrNull('January 2020')).toBe('2020-01-01');
    expect(parseToIsoDateOrNull('Sept 2019')).toBe('2019-09-01');
    expect(parseToIsoDateOrNull('  2020-05-14  ')).toBe('2020-05-14');
  });

  it('returns null (never a guess) for garbage, ambiguity, or impossible dates', () => {
    const garbage = [
      'last summer',
      'sometime in 2020',
      '01/02/2020', // ambiguous DD/MM vs MM/DD → refuse
      '2020-13-01', // impossible month
      '2020-00-10', // impossible month
      '2020-05-32', // impossible day
      '13/2020', // impossible month
      'Foo 2020', // not a month name
      '',
      '   ',
      'N/A',
    ];
    for (const g of garbage) {
      expect(parseToIsoDateOrNull(g)).toBeNull();
    }
    // Non-strings never parse.
    expect(parseToIsoDateOrNull(20200514)).toBeNull();
    expect(parseToIsoDateOrNull(null)).toBeNull();
    expect(parseToIsoDateOrNull(undefined)).toBeNull();
  });

  it('an unparseable EMPLOYMENT date → null WITH the raw preserved (never destroyed)', () => {
    const r = validateClaimShape('EMPLOYMENT', {
      employer_raw: 'Acme',
      role_title_raw: 'Engineer',
      start_date_raw: 'a while ago',
    });
    expect(r.ok).toBe(true);
    expect(r.canonical?.['start_date']).toBeNull();
    expect(r.canonical?.['start_date_raw']).toBe('a while ago');
  });
});

describe('employer equality-normalization — deterministic, NOT entity resolution', () => {
  it('converges corporate suffix/punctuation spellings of the same name', () => {
    const norm = (e: string) =>
      (validateClaimShape('EMPLOYMENT', { employer_raw: e, role_title_raw: 'x' })
        .canonical?.['employer_norm']) as string;
    expect(norm('Acme')).toBe('acme');
    expect(norm('Acme Inc.')).toBe('acme');
    expect(norm('ACME  LLC')).toBe('acme');
    expect(norm('Acme Co., Ltd.')).toBe('acme');
  });

  it('does NOT collapse genuinely different employers (conservative — no guessing)', () => {
    const norm = (e: string) =>
      (validateClaimShape('EMPLOYMENT', { employer_raw: e, role_title_raw: 'x' })
        .canonical?.['employer_norm']) as string;
    expect(norm('Acme')).not.toBe(norm('Acme Systems'));
    expect(norm('Acme Corp of Ohio')).not.toBe(norm('Acme'));
  });
});

describe('SKILL shape — deterministic skill_id', () => {
  it('derives a stable skill_id from the normalized surface form', () => {
    const r = validateClaimShape('SKILL', { value_raw: '  TypeScript ' });
    expect(r.ok).toBe(true);
    expect(r.canonical?.['value_raw']).toBe('TypeScript');
    expect(r.canonical?.['skill_id']).toBe(deriveSkillIdCanonical('TypeScript'));
    // Case/whitespace-insensitive derivation (same normalized text → same id).
    expect(deriveSkillIdCanonical('type script')).not.toBe(deriveSkillIdCanonical('TypeScript'));
    expect(deriveSkillIdCanonical('TYPESCRIPT')).toBe(deriveSkillIdCanonical('typescript'));
  });

  it('refuses a SKILL payload with no value_raw', () => {
    expect(validateClaimShape('SKILL', {}).ok).toBe(false);
  });
});

describe('contact shapes — canonical key `value` (§5c)', () => {
  it('EMAIL/PHONE/PROFILE_URL require value and preserve provenance', () => {
    for (const t of ['EMAIL', 'PHONE', 'PROFILE_URL']) {
      const r = validateClaimShape(t, { value: 'x@y.com', source_channel: 'ch', payload_id: 'p' });
      expect(r.ok).toBe(true);
      expect(r.canonical).toMatchObject({ value: 'x@y.com', source_channel: 'ch', payload_id: 'p' });
    }
  });

  it('a contact payload missing `value` refuses', () => {
    expect(validateClaimShape('EMAIL', { normalized_value: 'legacy@only.com' }).ok).toBe(false);
  });
});
