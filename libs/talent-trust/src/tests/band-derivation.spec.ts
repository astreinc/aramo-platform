import { describe, expect, it } from 'vitest';

import { deriveTrustState, type EvidenceForDerivation } from '../lib/band-derivation.js';
import { deriveStrength } from '../lib/strength.js';
import type {
  DecayProfile,
  EvidenceStatus,
  Method,
  SourceClass,
  TrustDimension,
} from '../lib/vocab.js';

// Pure band-derivation tests (§6) — the DoD core. No DB. `now` is injected and
// all evidence uses DURABLE decay so time-decay never perturbs the band rules
// under test (decay is exercised separately in strength.spec.ts).

const NOW = new Date('2026-06-28T00:00:00Z');

// TR-3 (OPEN-6) — a registry-listed assertion_type per dimension, so a record
// that reaches an isAuthoritative/≥AUTHORITATIVE_ISSUER class satisfies the new
// top-band *what-was-asserted* gate by default. Tests that prove the UNregistered
// case pass an explicit out-of-registry `assertion_type`.
const DEFAULT_REGISTERED_TYPE: Record<TrustDimension, string> = {
  IDENTITY: 'IDENTITY_DOCUMENT',
  CLAIMS: 'DEGREE',
  CONTINUITY: 'CONTINUITY_UNREGISTERED', // CONTINUITY registry is empty (fail-closed)
  ELIGIBILITY: 'RIGHT_TO_WORK',
};

function ev(
  partial: Partial<EvidenceForDerivation> & {
    dimension: TrustDimension;
    source_class: SourceClass;
    method: Method;
  },
): EvidenceForDerivation {
  return {
    strength: deriveStrength(partial.source_class, partial.method),
    current_status: 'VALID' as EvidenceStatus,
    decay_profile: 'DURABLE' as DecayProfile,
    collected_at: NOW,
    source_ref: null,
    assertion_type: DEFAULT_REGISTERED_TYPE[partial.dimension],
    ...partial,
  };
}

describe('deriveTrustState — band accrual rules (§6)', () => {
  it('empty ledger → all four dimensions NOT_ESTABLISHED', () => {
    const s = deriveTrustState([], NOW);
    expect(s.identity_band).toBe('NOT_ESTABLISHED');
    expect(s.claims_band).toBe('NOT_ESTABLISHED');
    expect(s.continuity_band).toBe('NOT_ESTABLISHED');
    expect(s.eligibility_band).toBe('NOT_ESTABLISHED');
    expect(s.open_contradiction_count).toBe(0);
    expect(s.stale_evidence_count).toBe(0);
    expect(s.has_open_dispute).toBe(false);
  });

  it('SELF-only evidence cannot exceed SELF_ASSERTED (the talent-controlled cap)', () => {
    const s = deriveTrustState(
      [ev({ dimension: 'CLAIMS', source_class: 'SELF', method: 'SELF_DECLARED' })],
      NOW,
    );
    expect(s.claims_band).toBe('SELF_ASSERTED');
  });

  it('five agreeing SELF claims collapse to one weak signal — still SELF_ASSERTED, never higher', () => {
    const five = Array.from({ length: 5 }, (_, i) =>
      ev({
        dimension: 'CLAIMS',
        source_class: 'SELF',
        method: 'SELF_DECLARED',
        // Even distinct source_refs collapse — SELF is talent-controlled.
        source_ref: { claim: i },
      }),
    );
    const s = deriveTrustState(five, NOW);
    expect(s.claims_band).toBe('SELF_ASSERTED');
  });

  it('≥1 independent THIRD_PARTY_VERIFIED → CORROBORATED', () => {
    const s = deriveTrustState(
      [
        ev({ dimension: 'CLAIMS', source_class: 'SELF', method: 'SELF_DECLARED' }),
        ev({ dimension: 'CLAIMS', source_class: 'THIRD_PARTY_VERIFIED', method: 'DOCUMENT' }),
      ],
      NOW,
    );
    expect(s.claims_band).toBe('CORROBORATED');
  });

  it('≥1 AUTHORITATIVE_ISSUER (document method) → INDEPENDENTLY_VERIFIED', () => {
    const s = deriveTrustState(
      [ev({ dimension: 'IDENTITY', source_class: 'AUTHORITATIVE_ISSUER', method: 'DOCUMENT' })],
      NOW,
    );
    expect(s.identity_band).toBe('INDEPENDENTLY_VERIFIED');
  });

  it('AUTHORITATIVE_ISSUER via API_REGISTRY → AUTHORITATIVE (defining authoritative source)', () => {
    const s = deriveTrustState(
      [
        ev({
          dimension: 'ELIGIBILITY',
          source_class: 'AUTHORITATIVE_ISSUER',
          method: 'API_REGISTRY',
        }),
      ],
      NOW,
    );
    expect(s.eligibility_band).toBe('AUTHORITATIVE');
  });

  it('BIOMETRIC source → AUTHORITATIVE', () => {
    const s = deriveTrustState(
      [ev({ dimension: 'IDENTITY', source_class: 'BIOMETRIC', method: 'BIOMETRIC' })],
      NOW,
    );
    expect(s.identity_band).toBe('AUTHORITATIVE');
  });

  it('dimensions move independently', () => {
    const s = deriveTrustState(
      [
        ev({ dimension: 'IDENTITY', source_class: 'BIOMETRIC', method: 'BIOMETRIC' }),
        ev({ dimension: 'CLAIMS', source_class: 'SELF', method: 'SELF_DECLARED' }),
        // CONTINUITY + ELIGIBILITY have no evidence.
      ],
      NOW,
    );
    expect(s.identity_band).toBe('AUTHORITATIVE');
    expect(s.claims_band).toBe('SELF_ASSERTED');
    expect(s.continuity_band).toBe('NOT_ESTABLISHED');
    expect(s.eligibility_band).toBe('NOT_ESTABLISHED');
  });
});

describe('deriveTrustState — contradiction cap (§7)', () => {
  it('an open contradiction caps the affected dimension at CORROBORATED and raises the count', () => {
    const s = deriveTrustState(
      [
        // Would otherwise be INDEPENDENTLY_VERIFIED…
        ev({ dimension: 'CLAIMS', source_class: 'AUTHORITATIVE_ISSUER', method: 'DOCUMENT' }),
        // …but an independent source contradicts it (status CONTRADICTED).
        ev({
          dimension: 'CLAIMS',
          source_class: 'THIRD_PARTY_VERIFIED',
          method: 'DOCUMENT',
          current_status: 'CONTRADICTED',
        }),
      ],
      NOW,
    );
    expect(s.claims_band).toBe('CORROBORATED');
    expect(s.open_contradiction_count).toBe(1);
  });

  it('the cap is per-dimension — a contradiction in CLAIMS does not cap IDENTITY', () => {
    const s = deriveTrustState(
      [
        ev({ dimension: 'IDENTITY', source_class: 'BIOMETRIC', method: 'BIOMETRIC' }),
        ev({
          dimension: 'CLAIMS',
          source_class: 'THIRD_PARTY_VERIFIED',
          method: 'DOCUMENT',
          current_status: 'CONTRADICTED',
        }),
      ],
      NOW,
    );
    expect(s.identity_band).toBe('AUTHORITATIVE');
    expect(s.claims_band).toBe('NOT_ESTABLISHED'); // its only evidence is CONTRADICTED (non-contributing)
    expect(s.open_contradiction_count).toBe(1);
  });
});

describe('deriveTrustState — non-VALID statuses do not accrue', () => {
  it('REVOKED / SUPERSEDED / STALE evidence does not raise a band', () => {
    const s = deriveTrustState(
      [
        ev({
          dimension: 'CLAIMS',
          source_class: 'AUTHORITATIVE_ISSUER',
          method: 'API_REGISTRY',
          current_status: 'REVOKED',
        }),
        ev({
          dimension: 'CLAIMS',
          source_class: 'BIOMETRIC',
          method: 'BIOMETRIC',
          current_status: 'SUPERSEDED',
        }),
        ev({
          dimension: 'CLAIMS',
          source_class: 'AUTHORITATIVE_ISSUER',
          method: 'API_REGISTRY',
          current_status: 'STALE',
        }),
      ],
      NOW,
    );
    expect(s.claims_band).toBe('NOT_ESTABLISHED');
    expect(s.stale_evidence_count).toBe(1);
  });

  it('supersession keeps the new VALID record contributing while the old SUPERSEDED one does not', () => {
    // Uses ELIGIBILITY (a dimension WITH a registered authoritative type,
    // RIGHT_TO_WORK via the ev() default) so the surviving authoritative record
    // can reach the top band — CONTINUITY's empty registry keeps it below by design
    // (proven in the TR-3 registry tests). The point here is the supersession
    // independence logic, which is dimension-agnostic.
    const s = deriveTrustState(
      [
        ev({
          dimension: 'ELIGIBILITY',
          source_class: 'THIRD_PARTY_VERIFIED',
          method: 'DOCUMENT',
          current_status: 'SUPERSEDED',
        }),
        ev({
          dimension: 'ELIGIBILITY',
          source_class: 'AUTHORITATIVE_ISSUER',
          method: 'API_REGISTRY',
          current_status: 'VALID',
        }),
      ],
      NOW,
    );
    // The surviving authoritative record drives the band; the superseded one is inert.
    expect(s.eligibility_band).toBe('AUTHORITATIVE');
  });

  it('a DISPUTED record flags has_open_dispute and stops contributing', () => {
    const s = deriveTrustState(
      [
        ev({
          dimension: 'ELIGIBILITY',
          source_class: 'AUTHORITATIVE_ISSUER',
          method: 'API_REGISTRY',
          current_status: 'DISPUTED',
        }),
      ],
      NOW,
    );
    expect(s.has_open_dispute).toBe(true);
    expect(s.eligibility_band).toBe('NOT_ESTABLISHED');
  });
});

describe('deriveTrustState — TR-3 (PLATFORM_VERIFIED class + OPEN-6 registry §3/§4)', () => {
  // (c) — the honest headline: a platform-verified email is CORROBORATED, no more.
  it('(c) a platform-verified email → IDENTITY = CORROBORATED exactly (not higher)', () => {
    const s = deriveTrustState(
      [
        ev({
          dimension: 'IDENTITY',
          source_class: 'PLATFORM_VERIFIED',
          method: 'CONTROL_ROUND_TRIP',
          assertion_type: 'EMAIL_CONTROL_VERIFIED',
        }),
      ],
      NOW,
    );
    // PLATFORM_VERIFIED clears the ≥THIRD_PARTY_VERIFIED gate (CORROBORATED) but
    // sits BELOW AUTHORITATIVE_ISSUER and is not isAuthoritative — so neither top
    // band fires, regardless of the (registered) assertion_type.
    expect(s.identity_band).toBe('CORROBORATED');
  });

  // (d) — the registry proven BOTH ways, per dimension.
  it('(d) UNREGISTERED assertion_type at ≥AUTHORITATIVE_ISSUER does NOT lift INDEPENDENTLY_VERIFIED', () => {
    const s = deriveTrustState(
      [
        ev({
          dimension: 'IDENTITY',
          source_class: 'AUTHORITATIVE_ISSUER',
          method: 'DOCUMENT',
          assertion_type: 'SKILL', // not in the IDENTITY registry
        }),
      ],
      NOW,
    );
    expect(s.identity_band).toBe('CORROBORATED'); // held below by the what-was-asserted gate
  });

  it('(d) REGISTERED assertion_type at ≥AUTHORITATIVE_ISSUER DOES lift INDEPENDENTLY_VERIFIED', () => {
    const s = deriveTrustState(
      [
        ev({
          dimension: 'IDENTITY',
          source_class: 'AUTHORITATIVE_ISSUER',
          method: 'DOCUMENT',
          assertion_type: 'IDENTITY_DOCUMENT', // registered for IDENTITY
        }),
      ],
      NOW,
    );
    expect(s.identity_band).toBe('INDEPENDENTLY_VERIFIED');
  });

  it('(d) UNREGISTERED at isAuthoritative class does NOT lift AUTHORITATIVE; a registered one does', () => {
    const unreg = deriveTrustState(
      [
        ev({
          dimension: 'IDENTITY',
          source_class: 'BIOMETRIC',
          method: 'BIOMETRIC',
          assertion_type: 'DEGREE', // registered for CLAIMS, not IDENTITY
        }),
      ],
      NOW,
    );
    expect(unreg.identity_band).toBe('CORROBORATED');
    const reg = deriveTrustState(
      [
        ev({
          dimension: 'IDENTITY',
          source_class: 'BIOMETRIC',
          method: 'BIOMETRIC',
          assertion_type: 'FACE_MATCH', // registered for IDENTITY
        }),
      ],
      NOW,
    );
    expect(reg.identity_band).toBe('AUTHORITATIVE');
  });

  it('(d) CONTINUITY has an EMPTY registry → its top gates stay unreachable (fail-closed)', () => {
    const s = deriveTrustState(
      [
        ev({
          dimension: 'CONTINUITY',
          source_class: 'BIOMETRIC',
          method: 'BIOMETRIC',
          assertion_type: 'LIVENESS', // registered for IDENTITY, but NOT for CONTINUITY
        }),
      ],
      NOW,
    );
    expect(s.continuity_band).toBe('CORROBORATED'); // the empty registry caps it below the top two
  });

  // (e) — the mechanical SELF cap survives the registry gate change.
  it('(e) SELF-only still caps at SELF_ASSERTED even with a registered assertion_type', () => {
    const s = deriveTrustState(
      [
        ev({
          dimension: 'IDENTITY',
          source_class: 'SELF',
          method: 'SELF_DECLARED',
          assertion_type: 'IDENTITY_DOCUMENT', // registered — but SELF class never clears the gate
        }),
      ],
      NOW,
    );
    expect(s.identity_band).toBe('SELF_ASSERTED');
  });
});
