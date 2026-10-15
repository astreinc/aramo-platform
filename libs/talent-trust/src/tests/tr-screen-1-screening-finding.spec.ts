import { describe, expect, it } from 'vitest';

import {
  deriveTrustState,
  sameUltimateSource,
  type EvidenceForDerivation,
} from '../lib/band-derivation.js';
import {
  isRegisteredAssertionType,
  validateClaimShape,
} from '../lib/canonical-claim-shapes.js';
import { deriveStrength } from '../lib/strength.js';
import { AUTHORITATIVE_ASSERTION_TYPES, PRESENTATION_BANDS, type Method, type SourceClass } from '../lib/vocab.js';

// TR-SCREEN-1 DDR (Aramo-TR-SCREEN-1-DDR-v1_0-LOCKED) — the SCREENING_FINDING
// canonical shape (§2.1), the one-group independence rule (§2.3) and the
// contribution ceiling (§2.5). Pure; no DB. Directive ARAMO-TIP-E2E-INC-3 §13
// rows 16, 17, 19, 20, 30–34.

const SESSION = '0192f000-0000-7000-8000-000000000001';
const FINDING = '0192f000-0000-7000-8000-000000000002';
const NOW = new Date('2026-10-15T00:00:00Z');

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    skill_raw: '  PostgreSQL  ',
    basis: 'RECRUITER_OBSERVED',
    observation_raw: 'Explained MVCC and vacuum trade-offs in depth.',
    confirmation: { confirmed_at: '2026-10-15T10:00:00Z', session_version: 3 },
    screening_ref: { screening_session_id: SESSION, screening_finding_id: FINDING },
    ...over,
  };
}

describe('TR-SCREEN-1 §2.1 — SCREENING_FINDING canonical shape', () => {
  it('is registered and deliberately absent from every authoritative registry', () => {
    expect(isRegisteredAssertionType('SCREENING_FINDING')).toBe(true);
    for (const types of Object.values(AUTHORITATIVE_ASSERTION_TYPES)) {
      expect(types).not.toContain('SCREENING_FINDING');
    }
  });

  it('canonicalizes a valid finding: trims, derives skill_id, pins independently_verified=false', () => {
    const r = validateClaimShape('SCREENING_FINDING', payload());
    expect(r.ok).toBe(true);
    expect(r.canonical?.['skill_raw']).toBe('PostgreSQL');
    expect(typeof r.canonical?.['skill_id']).toBe('string');
    expect(r.canonical?.['independently_verified']).toBe(false);
    expect(r.canonical?.['confirmation']).toEqual({
      confirmed_at: '2026-10-15T10:00:00.000Z',
      session_version: 3,
    });
  });

  it('is CLOSED: unknown keys (incl. any actor id or numeric rating) are dropped', () => {
    const r = validateClaimShape(
      'SCREENING_FINDING',
      payload({ rating: 5, confirmed_by_actor_id: 'u-1', tier: 'A' }),
    );
    expect(r.ok).toBe(true);
    expect(Object.keys(r.canonical ?? {}).sort()).toEqual(
      ['basis', 'confirmation', 'independently_verified', 'observation_raw', 'screening_ref', 'skill_id', 'skill_raw'].sort(),
    );
    expect(JSON.stringify(r.canonical)).not.toContain('u-1');
  });

  it('requires demonstration_raw iff basis = DEMONSTRATED (directive row 16)', () => {
    expect(validateClaimShape('SCREENING_FINDING', payload({ basis: 'DEMONSTRATED' })).ok).toBe(false);
    const ok = validateClaimShape(
      'SCREENING_FINDING',
      payload({ basis: 'DEMONSTRATED', demonstration_raw: 'Wrote a window-function query live.' }),
    );
    expect(ok.ok).toBe(true);
    expect(ok.canonical?.['demonstration_raw']).toBe('Wrote a window-function query live.');
    expect(
      validateClaimShape('SCREENING_FINDING', payload({ demonstration_raw: 'not allowed here' })).ok,
    ).toBe(false);
  });

  it('refuses an unknown basis, a missing observation and independently_verified ≠ false (row 17)', () => {
    expect(validateClaimShape('SCREENING_FINDING', payload({ basis: 'VERIFIED' })).ok).toBe(false);
    expect(validateClaimShape('SCREENING_FINDING', payload({ observation_raw: '  ' })).ok).toBe(false);
    expect(validateClaimShape('SCREENING_FINDING', payload({ independently_verified: true })).ok).toBe(false);
  });

  it('requires confirmation and a uuid screening_ref', () => {
    expect(validateClaimShape('SCREENING_FINDING', payload({ confirmation: undefined })).ok).toBe(false);
    expect(
      validateClaimShape('SCREENING_FINDING', payload({ confirmation: { confirmed_at: 'x', session_version: 1 } })).ok,
    ).toBe(false);
    expect(
      validateClaimShape('SCREENING_FINDING', payload({ screening_ref: { screening_session_id: SESSION } })).ok,
    ).toBe(false);
  });

  it('keeps optional limitations_raw', () => {
    const r = validateClaimShape('SCREENING_FINDING', payload({ limitations_raw: ' No replication topics covered. ' }));
    expect(r.canonical?.['limitations_raw']).toBe('No replication topics covered.');
  });
});

function screening(
  sourceClass: SourceClass,
  method: Method,
  findingId: string,
): EvidenceForDerivation {
  return {
    dimension: 'CLAIMS',
    source_class: sourceClass,
    method,
    assertion_type: 'SCREENING_FINDING',
    strength: deriveStrength(sourceClass, method),
    current_status: 'VALID',
    decay_profile: 'DURABLE',
    collected_at: NOW,
    source_ref: { screening_finding_id: findingId },
  };
}
const observed = (id: string): EvidenceForDerivation =>
  screening('THIRD_PARTY_UNVERIFIED', 'HUMAN_ATTESTED', id);
const selfReported = (id: string): EvidenceForDerivation => screening('SELF', 'SELF_DECLARED', id);
const resumeSelfSkill: EvidenceForDerivation = {
  dimension: 'CLAIMS',
  source_class: 'SELF',
  method: 'SELF_DECLARED',
  assertion_type: 'SKILL',
  strength: deriveStrength('SELF', 'SELF_DECLARED'),
  current_status: 'VALID',
  decay_profile: 'DURABLE',
  collected_at: NOW,
  source_ref: null,
};

const bandIndex = (b: string): number => (PRESENTATION_BANDS as readonly string[]).indexOf(b);

describe('TR-SCREEN-1 §2.3 — one screening independence group per subject', () => {
  it('N findings by any recruiters / sessions / interactions collapse to ONE group (rows 20, 30–32)', () => {
    const state = deriveTrustState([observed('a'), observed('b'), observed('c'), observed('d')], NOW);
    expect(state.single_source_only).toBe(true);
  });

  it('SELF_REPORTED screening joins the existing SELF group, not the screening group (row 34)', () => {
    // résumé SELF + screening SELF_REPORTED → still ONE group (SELF).
    expect(deriveTrustState([resumeSelfSkill, selfReported('a')], NOW).single_source_only).toBe(true);
    // résumé SELF + recruiter-observed screening → SELF + screening = two groups.
    expect(deriveTrustState([resumeSelfSkill, observed('a')], NOW).single_source_only).toBe(false);
    // ...and more screening rows never add a third.
    const many = deriveTrustState([resumeSelfSkill, selfReported('x'), observed('a'), observed('b')], NOW);
    expect(many.single_source_only).toBe(false);
  });

  it('sameUltimateSource mirrors independenceKey exactly', () => {
    expect(sameUltimateSource(observed('a'), observed('b'))).toBe(true);
    expect(sameUltimateSource(selfReported('a'), resumeSelfSkill)).toBe(true);
    expect(sameUltimateSource(observed('a'), selfReported('a'))).toBe(false);
    const attestation = {
      source_class: 'THIRD_PARTY_UNVERIFIED' as SourceClass,
      source_ref: { screening_finding_id: 'a' },
      assertion_type: 'ATTESTATION',
    };
    expect(sameUltimateSource(observed('a'), attestation)).toBe(false);
  });
});

describe('TR-SCREEN-1 §2.5 — contribution ceiling, not an overall cap', () => {
  it('screening evidence alone never derives a CLAIMS band above SELF_ASSERTED (row 19)', () => {
    const state = deriveTrustState(
      [observed('a'), observed('b'), screening('THIRD_PARTY_UNVERIFIED', 'HUMAN_ATTESTED', 'c')],
      NOW,
    );
    expect(bandIndex(state.claims_band)).toBeLessThanOrEqual(bandIndex('SELF_ASSERTED'));
  });

  it('a verified credential still raises the CLAIMS band above SELF_ASSERTED (row 33)', () => {
    const degree: EvidenceForDerivation = {
      dimension: 'CLAIMS',
      source_class: 'AUTHORITATIVE_ISSUER',
      method: 'API_REGISTRY',
      assertion_type: 'DEGREE',
      strength: deriveStrength('AUTHORITATIVE_ISSUER', 'API_REGISTRY'),
      current_status: 'VALID',
      decay_profile: 'DURABLE',
      collected_at: NOW,
      source_ref: { issuer: 'registry-1' },
    };
    const state = deriveTrustState([observed('a'), degree], NOW);
    expect(bandIndex(state.claims_band)).toBeGreaterThan(bandIndex('SELF_ASSERTED'));
  });
});
