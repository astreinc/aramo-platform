import type { DecayProfile, Method, SourceClass } from './vocab.js';

// Strength derivation (§6.1) + time-decay (§7) — pure, no I/O.
//
// "Strength is derived, not entered — a published function of
// source_class × method." The exact WEIGHTS are tunable later; the ORDERING
// is fixed by R2 (a SELF/SELF_DECLARED skill ≈ nil; an
// AUTHORITATIVE_ISSUER/API_REGISTRY degree = high). Strength is internal
// only — never surfaced as a talent-level number (R4).

// Base weight per source_class — monotonically non-decreasing along the R2
// ladder. SELF is deliberately near-nil.
const SOURCE_CLASS_WEIGHT: Record<SourceClass, number> = {
  SELF: 0.1,
  THIRD_PARTY_UNVERIFIED: 0.3,
  THIRD_PARTY_VERIFIED: 0.6,
  AUTHORITATIVE_ISSUER: 0.9,
  CRYPTOGRAPHIC: 0.95,
  BIOMETRIC: 0.95,
};

// Method multiplier — how the assertion was obtained. A self-declaration is
// weak regardless of source; an API-registry / signature / biometric pull is
// full-strength.
const METHOD_MULTIPLIER: Record<Method, number> = {
  SELF_DECLARED: 0.5,
  DOCUMENT: 0.8,
  API_REGISTRY: 1.0,
  SIGNATURE: 1.0,
  BIOMETRIC: 1.0,
  HUMAN_ATTESTED: 0.7,
};

// Base strength at collection time (persisted on EvidenceRecord.strength).
// Clamped to [0, 1].
export function deriveStrength(sourceClass: SourceClass, method: Method): number {
  const raw = SOURCE_CLASS_WEIGHT[sourceClass] * METHOD_MULTIPLIER[method];
  return Math.max(0, Math.min(1, raw));
}

// Approximate half-life (in days) per decay profile (§7). DURABLE never
// decays; PER_STEP collapses to near-zero almost immediately after the step
// it attested (so it must be re-established at each high-stakes step rather
// than coasting).
const HALF_LIFE_DAYS: Record<Exclude<DecayProfile, 'DURABLE' | 'PER_STEP'>, number> = {
  SLOW: 730, // ~2 years
  MODERATE: 180, // ~6 months
  FAST: 30, // ~1 month
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Effective strength at `now`, applying §7 gradual decay to the persisted
// base. This is what band derivation reads.
//
//   - DURABLE  → no decay (e.g. a registrar-confirmed degree).
//   - PER_STEP → ~0 once any meaningful time has passed since collection
//                (decays to near-zero immediately after its step).
//   - SLOW/MODERATE/FAST → exponential half-life decay.
export function effectiveStrength(
  baseStrength: number,
  decayProfile: DecayProfile,
  collectedAt: Date,
  now: Date,
): number {
  if (decayProfile === 'DURABLE') return baseStrength;

  const ageMs = Math.max(0, now.getTime() - collectedAt.getTime());
  const ageDays = ageMs / MS_PER_DAY;

  if (decayProfile === 'PER_STEP') {
    // Effectively single-use: full strength only at the instant of the step,
    // near-zero within a day. Half-life of 1 day approximates "must be
    // re-established at each step."
    return baseStrength * Math.pow(0.5, ageDays / 1);
  }

  const halfLife = HALF_LIFE_DAYS[decayProfile];
  return baseStrength * Math.pow(0.5, ageDays / halfLife);
}
