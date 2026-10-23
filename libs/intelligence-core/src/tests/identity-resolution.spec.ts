import { describe, expect, it } from 'vitest';

import {
  GovIdTokenizationUnavailableError,
  GovIdTokenizer,
  canonicalJson,
  decideResolution,
  isMaterialIdentityChange,
  namesConflict,
  normalizeEmail,
  normalizeNames,
  normalizePhone,
  type IdentitySnapshot,
  type ResolutionFacts,
} from '../index.js';

// ATI-SEP-1 T3 (ADR-0036 §5) — the pure resolution decision, rules R1–R5, and
// the normalization it depends on.

const PRIYA = normalizeNames({ first: 'Priya', last: 'Raman' });
const JOHN = normalizeNames({ first: 'John', last: 'Doe' });

function snap(verified: string[], names = PRIYA, unverified: string[] = []): IdentitySnapshot {
  return { names, verified: [...verified].sort(), unverified: [...unverified].sort() };
}

function facts(over: Partial<ResolutionFacts>): ResolutionFacts {
  return { request: snap([]), existing_reference: null, verified_matches: [], subject_names: {}, ...over };
}

describe('normalization', () => {
  it('emails are trimmed and lowercased', () => {
    expect(normalizeEmail('  Priya.Raman@Example.COM ')).toBe('priya.raman@example.com');
  });

  it('phones become + digits (bare 10 digits read as NANP)', () => {
    expect(normalizePhone('(555) 010-2000')).toBe('+15550102000');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('1-555-010-2000')).toBe('+15550102000');
  });

  it('government ids are a keyed HMAC token — stable across formatting, never the raw value', () => {
    const t = GovIdTokenizer.withKey('k'.repeat(32));
    const a = t.token('us', 'ssn', '123-45-6789');
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(t.token('US', 'SSN', '123 45 6789'));
    expect(a).not.toContain('6789');
    expect(a).not.toBe(GovIdTokenizer.withKey('j'.repeat(32)).token('US', 'SSN', '123-45-6789'));
    expect(a).not.toBe(t.token('CA', 'SSN', '123-45-6789'));
  });

  it('the tokenizer fails closed without a key', () => {
    const t = GovIdTokenizer.fromEnv({});
    expect(t.available).toBe(false);
    expect(() => t.token('US', 'SSN', '1')).toThrow(GovIdTokenizationUnavailableError);
    expect(GovIdTokenizer.fromEnv({ INTELLIGENCE_GOV_ID_TOKEN_KEY: 'short' }).available).toBe(false);
  });

  it('names compare without case, accents or initials getting in the way', () => {
    expect(namesConflict(PRIYA, normalizeNames({ first: 'PRIYA', last: 'Ráman' }))).toBe(false);
    expect(namesConflict(PRIYA, normalizeNames({ first: 'P', last: 'Raman' }))).toBe(false);
    expect(namesConflict(PRIYA, normalizeNames({ aliases: ['Priya Raman'] }))).toBe(false);
    expect(namesConflict(PRIYA, JOHN)).toBe(true);
    // absence never conflicts
    expect(namesConflict(PRIYA, {})).toBe(false);
  });

  it('canonical JSON is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [1, { x: 2, y: 1 }] }, b: 1 }));
  });
});

describe('decideResolution — R1 existing reference is authoritative', () => {
  const ref = { id: 'ref-1', subject_id: 'S1', snapshot: snap(['EMAIL:priya@example.com']) };

  it('same subject, no conflict, when identity is unchanged', () => {
    const d = decideResolution(facts({ request: snap(['EMAIL:priya@example.com']), existing_reference: ref }));
    expect(d).toMatchObject({ rule: 'EXISTING_REFERENCE', subject_id: 'S1', conflicts: [] });
  });

  it('a new verified email alone is not a mutation (one anchor still matches or names match)', () => {
    const d = decideResolution(facts({ request: snap(['EMAIL:new@example.com']), existing_reference: ref }));
    expect(d.conflicts).toEqual([]);
  });

  it('all verified anchors differ AND names differ → REFERENCE_IDENTITY_MUTATION, still the same subject', () => {
    const d = decideResolution(facts({ request: snap(['EMAIL:john@example.com'], JOHN), existing_reference: ref }));
    expect(d.rule).toBe('EXISTING_REFERENCE');
    expect(d.subject_id).toBe('S1');
    expect(d.conflicts.map((c) => c.conflict_type)).toEqual(['REFERENCE_IDENTITY_MUTATION']);
  });

  it('names differ but an anchor is kept → no mutation', () => {
    const d = decideResolution(facts({ request: snap(['EMAIL:priya@example.com'], JOHN), existing_reference: ref }));
    expect(d.conflicts).toEqual([]);
  });

  it('an anchor of this reference bound to ANOTHER subject → ANCHOR_CONTRADICTION, never a merge', () => {
    const d = decideResolution(
      facts({
        request: snap(['EMAIL:priya@example.com', 'PHONE:+15550102000']),
        existing_reference: ref,
        verified_matches: [
          { key: 'EMAIL:priya@example.com', subject_id: 'S1' },
          { key: 'PHONE:+15550102000', subject_id: 'S2' },
        ],
      }),
    );
    expect(d.subject_id).toBe('S1');
    expect(d.conflicts).toHaveLength(1);
    expect(d.conflicts[0]).toMatchObject({ conflict_type: 'ANCHOR_CONTRADICTION', related_subject_ids: ['S2'] });
  });

  it('isMaterialIdentityChange needs verified anchors on both sides', () => {
    expect(isMaterialIdentityChange(snap([]), snap(['EMAIL:a@x.io'], JOHN))).toBe(false);
    expect(isMaterialIdentityChange(snap(['EMAIL:a@x.io']), snap([], JOHN))).toBe(false);
  });
});

describe('decideResolution — R2 verified anchor links deterministically', () => {
  it('one subject matched → link (VERIFIED_ANCHOR)', () => {
    const d = decideResolution(
      facts({
        request: snap(['EMAIL:priya@example.com']),
        verified_matches: [{ key: 'EMAIL:priya@example.com', subject_id: 'S1' }],
        subject_names: { S1: [PRIYA] },
      }),
    );
    expect(d).toMatchObject({ rule: 'VERIFIED_ANCHOR', subject_id: 'S1', linked_by_verified_anchor: true, conflicts: [] });
  });

  it('several anchors on the SAME subject → still one link', () => {
    const d = decideResolution(
      facts({
        request: snap(['EMAIL:priya@example.com', 'PHONE:+15550102000']),
        verified_matches: [
          { key: 'EMAIL:priya@example.com', subject_id: 'S1' },
          { key: 'PHONE:+15550102000', subject_id: 'S1' },
        ],
      }),
    );
    expect(d.subject_id).toBe('S1');
  });

  it('anchors on >1 subjects → NO merge: new PROVISIONAL subject + ANCHOR_CONTRADICTION naming both', () => {
    const d = decideResolution(
      facts({
        request: snap(['EMAIL:priya@example.com', 'PHONE:+15550102000']),
        verified_matches: [
          { key: 'EMAIL:priya@example.com', subject_id: 'S2' },
          { key: 'PHONE:+15550102000', subject_id: 'S1' },
        ],
      }),
    );
    expect(d.rule).toBe('ANCHOR_CONTRADICTION');
    expect(d.subject_id).toBeNull();
    expect(d.conflicts[0]).toMatchObject({ conflict_type: 'ANCHOR_CONTRADICTION', related_subject_ids: ['S1', 'S2'] });
    expect(d.conflicts[0]?.details['anchors_by_subject']).toEqual({ S1: ['PHONE:+15550102000'], S2: ['EMAIL:priya@example.com'] });
  });
});

describe('decideResolution — R3 / R4 / R5', () => {
  it('R3 — unverified data never links (not even presented as a match)', () => {
    const d = decideResolution(facts({ request: snap([], PRIYA, ['EMAIL:priya@example.com']) }));
    expect(d).toMatchObject({ rule: 'NEW_PROVISIONAL', subject_id: null });
  });

  it('R4 — same verified anchor, conflicting name → same subject + IDENTITY_ATTRIBUTE_CONFLICT', () => {
    const d = decideResolution(
      facts({
        request: snap(['PHONE:+15550102000'], JOHN),
        verified_matches: [{ key: 'PHONE:+15550102000', subject_id: 'S1' }],
        subject_names: { S1: [PRIYA] },
      }),
    );
    expect(d.subject_id).toBe('S1');
    expect(d.conflicts.map((c) => c.conflict_type)).toEqual(['IDENTITY_ATTRIBUTE_CONFLICT']);
    expect(JSON.stringify(d.conflicts)).not.toMatch(/fraud/i);
  });

  it('R4 — a name matching ANY known name of the subject is not a conflict', () => {
    const d = decideResolution(
      facts({
        request: snap(['PHONE:+15550102000'], PRIYA),
        verified_matches: [{ key: 'PHONE:+15550102000', subject_id: 'S1' }],
        subject_names: { S1: [JOHN, PRIYA] },
      }),
    );
    expect(d.conflicts).toEqual([]);
  });

  it('R5 — nothing matched → new PROVISIONAL subject', () => {
    expect(decideResolution(facts({ request: snap(['EMAIL:new@example.com']) }))).toMatchObject({
      rule: 'NEW_PROVISIONAL',
      subject_id: null,
      conflicts: [],
    });
  });

  it('conflict signatures are deterministic (repeat snapshots do not re-open)', () => {
    const f = facts({
      request: snap(['PHONE:+15550102000'], JOHN),
      verified_matches: [{ key: 'PHONE:+15550102000', subject_id: 'S1' }],
      subject_names: { S1: [PRIYA] },
    });
    expect(decideResolution(f).conflicts[0]?.details.signature).toBe(decideResolution(f).conflicts[0]?.details.signature);
  });
});
