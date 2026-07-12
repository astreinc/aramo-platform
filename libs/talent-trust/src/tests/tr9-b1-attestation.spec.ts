import { describe, expect, it } from 'vitest';

import {
  validateClaimShape,
  attesterDescriptorKey,
  STATEMENT_CLASS_DIMENSION,
} from '../lib/canonical-claim-shapes.js';
import { detectAttesterIdentityOverlap } from '../lib/consistency-detectors.js';

// TR-9 B1 — the reference-attestation shape, the descriptor key (D3), and the
// ATTESTER_IDENTITY_OVERLAP detector (D4). Pure, no DB.

describe('ATTESTATION shape (§5b — the shape refuses a rating structurally)', () => {
  const valid = {
    attester: { name_raw: '  Ada Lovelace ', email_raw: 'Ada@Example.COM', company_raw: 'Analytical Engines', role_raw: 'Manager' },
    relationship_raw: 'former manager',
    statement_class: 'WORK',
    statement_raw: 'Ada led the difference-engine team for two years.',
    period: { start_raw: 'Jan 2019', end_raw: '2021-03' },
    // A malicious quality-number under two guises — the shape has NO such field,
    // so both are DROPPED. A reference with a number is a review, not evidence.
    rating: 5,
    quality_number: 9.9,
  };

  it('normalizes the attester email + preserves raw; dates parse ISO-or-null; NO quality number survives', () => {
    const r = validateClaimShape('ATTESTATION', valid);
    expect(r.ok).toBe(true);
    const c = r.canonical!;
    const attester = c['attester'] as Record<string, unknown>;
    expect(attester['name_raw']).toBe('Ada Lovelace'); // trimmed, raw preserved
    expect(attester['email_norm']).toBe('ada@example.com'); // matcher's normalization
    expect(attester['company_raw']).toBe('Analytical Engines');
    const period = c['period'] as Record<string, unknown>;
    expect(period['start']).toBe('2019-01-01'); // "Jan 2019" → month granularity floor
    expect(period['end']).toBe('2021-03-01'); // "2021-03" → month granularity
    expect(period['start_raw']).toBe('Jan 2019'); // raw preserved beside
    // STRUCTURAL R10: no quality-number field survives on the canonical shape.
    expect('rating' in c).toBe(false);
    expect('quality_number' in c).toBe(false);
    expect(JSON.stringify(c)).not.toContain('rating');
    expect(JSON.stringify(c)).not.toContain('9.9');
  });

  it('refuses a malformed payload via the registry gate (missing required fields)', () => {
    expect(validateClaimShape('ATTESTATION', { attester: {} }).ok).toBe(false);
    expect(validateClaimShape('ATTESTATION', { attester: { name_raw: 'X' }, relationship_raw: 'ref' }).ok).toBe(false); // no statement/class
    expect(
      validateClaimShape('ATTESTATION', {
        attester: { name_raw: 'X' },
        relationship_raw: 'ref',
        statement_class: 'NONSENSE',
        statement_raw: 'x',
      }).ok,
    ).toBe(false); // bad statement_class
  });

  it('email absent → no email_norm (the descriptor falls back to name+company)', () => {
    const r = validateClaimShape('ATTESTATION', {
      attester: { name_raw: 'Grace Hopper', company_raw: 'US Navy' },
      relationship_raw: 'colleague',
      statement_class: 'SKILL',
      statement_raw: 'Excellent debugger.',
    });
    expect(r.ok).toBe(true);
    expect('email_norm' in (r.canonical!['attester'] as object)).toBe(false);
  });

  it('statement_class maps to the right dimension', () => {
    expect(STATEMENT_CLASS_DIMENSION['SKILL']).toBe('CLAIMS');
    expect(STATEMENT_CLASS_DIMENSION['WORK']).toBe('CLAIMS');
    expect(STATEMENT_CLASS_DIMENSION['TENURE']).toBe('CONTINUITY');
  });
});

describe('attesterDescriptorKey (§5c — the D3 independence key)', () => {
  it('keys on email_norm when present', () => {
    expect(attesterDescriptorKey({ name_raw: 'Ada', email_norm: 'ada@x.com', company_raw: 'X' })).toBe('email:ada@x.com');
  });
  it('falls back to normalized name+company when no email', () => {
    expect(attesterDescriptorKey({ name_raw: '  Ada  Lovelace ', company_raw: 'Analytical  Engines' })).toBe('nameco:ada lovelace|analytical engines');
  });
  it('two references from ONE person share the key; a different person differs', () => {
    const a = attesterDescriptorKey({ name_raw: 'Ada', email_norm: 'ada@x.com' });
    const b = attesterDescriptorKey({ name_raw: 'Ada L.', email_norm: 'ada@x.com' }); // same email
    const c = attesterDescriptorKey({ name_raw: 'Grace', email_norm: 'grace@y.com' });
    expect(a).toBe(b); // one voice
    expect(a).not.toBe(c); // distinct voice
  });
});

describe('detectAttesterIdentityOverlap (§5d — the ring tell, both ways)', () => {
  const claim = (id: string, email: string | null, status = 'VALID' as const) => ({
    evidence_id: id,
    attester_email_norm: email,
    current_status: status,
  });

  it('flags an attestation whose email is a subject anchor value; silent on absent email', () => {
    const attestations = [
      claim('a1', 'ghost@self.com'), // the referee IS the talent's own identity
      claim('a2', 'real@ref.com'), // a genuine external referee
      claim('a3', null), // no email → SILENT
    ];
    const anchorEmails = new Set(['ghost@self.com']); // the tenant's own anchor value
    expect(detectAttesterIdentityOverlap(attestations, anchorEmails)).toEqual(['a1']);
  });

  it('empty overlap set → nothing flagged', () => {
    expect(
      detectAttesterIdentityOverlap([claim('a1', 'x@y.com')], new Set()),
    ).toEqual([]);
  });

  it('an already-CONTRADICTED overlap is skipped (idempotent with contradictRecord)', () => {
    expect(
      detectAttesterIdentityOverlap([claim('a1', 'x@y.com', 'CONTRADICTED')], new Set(['x@y.com'])),
    ).toEqual([]);
  });
});
