import { effectiveStrength } from './strength.js';
import {
  AUTHORITATIVE_ASSERTION_TYPES,
  PRESENTATION_BANDS,
  SOURCE_CLASSES,
  type DecayProfile,
  type EvidenceStatus,
  type Method,
  type PresentationBand,
  type SourceClass,
  type TrustDimension,
} from './vocab.js';
import { TRUST_DIMENSIONS } from './vocab.js';

// Band derivation (§6) + contradiction cap (§7) — pure, no I/O. The single
// testable core of TR-1: given the evidence ledger for a subject, produce the
// materialized TrustState (four per-dimension bands + flags). The repository
// persists whatever this returns; this function NEVER reads or writes a DB.

// The minimal evidence projection band derivation needs. Mirrors the
// persisted EvidenceRecord columns relevant to §6.
export interface EvidenceForDerivation {
  dimension: TrustDimension;
  source_class: SourceClass;
  method: Method;
  // TR-3 (OPEN-6, §3) — WHAT the record asserts (a free string). The
  // authoritative-assertion-type registry gates the top two bands on it; band
  // derivation previously ignored it (Recon Q1.2 — only how-it-arrived counted).
  assertion_type: string;
  // Persisted base strength (deriveStrength(source_class, method)).
  strength: number;
  current_status: EvidenceStatus;
  decay_profile: DecayProfile;
  collected_at: Date;
  // Independence key input (§6.2): the specific issuer/party. Correlated
  // evidence (same ultimate source) collapses and counts once.
  source_ref: unknown | null;
}

export interface DerivedTrustState {
  identity_band: PresentationBand;
  claims_band: PresentationBand;
  continuity_band: PresentationBand;
  eligibility_band: PresentationBand;
  open_contradiction_count: number;
  stale_evidence_count: number;
  has_open_dispute: boolean;
  // TR-5 B2 (DDR §4) — named thinness, surfaced as statements never numbers.
  // single_source_only: all VALID first-hand evidence collapses to ONE
  // independence group (DERIVED signals are inferences, not sources — excluded).
  // longitudinal_observed: ≥1 VALID LONGITUDINAL_PRESENCE row (this identity
  // persisted across arrivals).
  single_source_only: boolean;
  longitudinal_observed: boolean;
}

const bandRank = (b: PresentationBand): number => PRESENTATION_BANDS.indexOf(b);
const classRank = (c: SourceClass): number => SOURCE_CLASSES.indexOf(c);

// An effective-strength floor below which a (possibly fully-decayed) signal no
// longer counts toward raising a band. Keeps a PER_STEP/expired record from
// propping up a band forever.
const CONTRIBUTION_FLOOR = 0.01;

// The independence key (§6.2). SELF is talent-controlled — ALL self
// evidence collapses to a single weak signal regardless of source_ref ("five
// self-claims agreeing is one weak signal, not five"). For non-SELF, evidence
// sharing a source_ref (same ultimate source) collapses; a null source_ref is
// treated as its own independent signal.
function independenceKey(e: EvidenceForDerivation, index: number): string {
  if (e.source_class === 'SELF') return 'SELF';
  if (e.source_ref === null || e.source_ref === undefined) return `__independent__:${index}`;
  return `ref:${stableStringify(e.source_ref)}`;
}

// TR-4 B3 — do two evidence rows share an ultimate source (i.e. collapse to ONE
// signal under §6.2)? Mirrors independenceKey EXACTLY so the consistency
// detector's "independent sources" definition is the band derivation's own:
//   - both SELF → same source (all self-claims collapse);
//   - one SELF, one not → distinct;
//   - both non-SELF with a null source_ref → distinct (each its own signal);
//   - both non-SELF with structurally-equal source_ref → same;
//   - else distinct.
// The employer-disagreement detector fires ONLY on independent pairs
// (!sameUltimateSource), so two SELF claims disagreeing stay silent.
export function sameUltimateSource(
  a: { source_class: SourceClass; source_ref: unknown | null },
  b: { source_class: SourceClass; source_ref: unknown | null },
): boolean {
  if (a.source_class === 'SELF' && b.source_class === 'SELF') return true;
  if (a.source_class === 'SELF' || b.source_class === 'SELF') return false;
  if (a.source_ref === null || a.source_ref === undefined) return false;
  if (b.source_ref === null || b.source_ref === undefined) return false;
  return stableStringify(a.source_ref) === stableStringify(b.source_ref);
}

// Deterministic JSON stringify (object keys sorted) so two structurally-equal
// source_refs collapse to the same independence key.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

// Does an AUTHORITATIVE_ISSUER-or-higher group qualify as AUTHORITATIVE (the
// top band — "the dimension's defining authoritative source confirms it")?
// CRYPTOGRAPHIC / BIOMETRIC are inherently authoritative; an
// AUTHORITATIVE_ISSUER reaches it only via a binding method (registry pull or
// signature), not a scanned document. Tunable; ordering is the fixed part.
function isAuthoritative(sourceClass: SourceClass, method: Method): boolean {
  if (sourceClass === 'CRYPTOGRAPHIC' || sourceClass === 'BIOMETRIC') return true;
  if (sourceClass === 'AUTHORITATIVE_ISSUER') {
    return method === 'API_REGISTRY' || method === 'SIGNATURE';
  }
  return false;
}

function deriveDimensionBand(
  dimension: TrustDimension,
  evidence: EvidenceForDerivation[],
  now: Date,
  dimensionHasOpenContradiction: boolean,
): PresentationBand {
  // Only VALID evidence raises a band. STALE / CONTRADICTED / REVOKED /
  // SUPERSEDED / DISPUTED do not contribute to accrual.
  const contributing = evidence.filter(
    (e) =>
      e.current_status === 'VALID' &&
      effectiveStrength(e.strength, e.decay_profile, e.collected_at, now) >= CONTRIBUTION_FLOOR,
  );
  if (contributing.length === 0) return 'NOT_ESTABLISHED';

  // Independence-weighted, not count-weighted (§6.2): collapse correlated
  // evidence, keep the strongest record per independent source.
  const groups = new Map<string, EvidenceForDerivation>();
  contributing.forEach((e, i) => {
    const key = independenceKey(e, i);
    const incumbent = groups.get(key);
    if (incumbent === undefined || classRank(e.source_class) > classRank(incumbent.source_class)) {
      groups.set(key, e);
    }
  });
  const independent = [...groups.values()];

  // The highest source_class present across independent groups gates the band —
  // the *how-it-arrived* axis. TR-3 (OPEN-6, §3) adds a *what-was-asserted* axis
  // on the TOP TWO bands: INDEPENDENTLY_VERIFIED / AUTHORITATIVE additionally
  // require a contributing record whose assertion_type is registry-listed for
  // this dimension AT the gating class. CORROBORATED and below are unchanged.
  const registeredTypes = new Set<string>(AUTHORITATIVE_ASSERTION_TYPES[dimension]);
  let band: PresentationBand = 'SELF_ASSERTED';
  const hasIndependentThirdPartyVerifiedOrHigher = independent.some(
    (e) => classRank(e.source_class) >= classRank('THIRD_PARTY_VERIFIED'),
  );
  // ≥ AUTHORITATIVE_ISSUER class AND a registry-listed assertion_type for the
  // dimension (a CONTINUITY-empty registry keeps this unreachable — fail-closed).
  const hasRegisteredAtAuthoritativeIssuerOrHigher = independent.some(
    (e) =>
      classRank(e.source_class) >= classRank('AUTHORITATIVE_ISSUER') &&
      registeredTypes.has(e.assertion_type),
  );
  // isAuthoritative class AND a registry-listed assertion_type for the dimension.
  const hasRegisteredAuthoritative = independent.some(
    (e) => isAuthoritative(e.source_class, e.method) && registeredTypes.has(e.assertion_type),
  );

  // SELF can raise a dimension at most to SELF_ASSERTED and never to verified
  // (§5.2 / §6.3 — the "never verify through a talent-controlled channel"
  // rule, enforced mechanically). The gates below only ever consider non-SELF
  // classes, so SELF-only evidence stays at SELF_ASSERTED.
  if (hasIndependentThirdPartyVerifiedOrHigher) band = 'CORROBORATED';
  if (hasRegisteredAtAuthoritativeIssuerOrHigher) band = 'INDEPENDENTLY_VERIFIED';
  if (hasRegisteredAuthoritative) band = 'AUTHORITATIVE';

  // Contradiction cap (§7): a confirmed contradiction between independent
  // sources caps the dimension — it cannot reach INDEPENDENTLY_VERIFIED while
  // an open contradiction stands, regardless of corroboration elsewhere.
  if (dimensionHasOpenContradiction) {
    const CONTRADICTION_CAP: PresentationBand = 'CORROBORATED';
    if (bandRank(band) > bandRank(CONTRADICTION_CAP)) band = CONTRADICTION_CAP;
  }

  return band;
}

// Derive the full TrustState projection from a subject's evidence ledger.
// `now` is injected (no Date.now() in pure logic) so decay + tests are
// deterministic.
export function deriveTrustState(
  evidence: EvidenceForDerivation[],
  now: Date,
): DerivedTrustState {
  // A dimension has an open contradiction when ≥1 of its evidence records is
  // currently CONTRADICTED (a CONTRADICTED event was applied and not resolved).
  const dimensionsWithOpenContradiction = new Set<TrustDimension>(
    evidence.filter((e) => e.current_status === 'CONTRADICTED').map((e) => e.dimension),
  );

  const bandFor = (dimension: TrustDimension): PresentationBand =>
    deriveDimensionBand(
      dimension,
      evidence.filter((e) => e.dimension === dimension),
      now,
      dimensionsWithOpenContradiction.has(dimension),
    );

  // Reference TRUST_DIMENSIONS so the four-dimension contract (R1) is the
  // single source of truth; the explicit fields below mirror the schema.
  void TRUST_DIMENSIONS;

  // TR-5 B2 (DDR §4) — thinness flags. single_source_only counts distinct
  // independence groups over VALID FIRST-HAND evidence: DERIVED rows (gaps,
  // spans, presence, platform-derived contradictions) are inferences FROM the
  // ledger, not new sources — including them would falsely clear thinness.
  const firstHand = evidence.filter((e) => e.current_status === 'VALID' && e.method !== 'DERIVED');
  const groups = new Set<string>(firstHand.map((e, i) => independenceKey(e, i)));
  const single_source_only = groups.size === 1;
  const longitudinal_observed = evidence.some(
    (e) => e.current_status === 'VALID' && e.assertion_type === 'LONGITUDINAL_PRESENCE',
  );

  return {
    identity_band: bandFor('IDENTITY'),
    claims_band: bandFor('CLAIMS'),
    continuity_band: bandFor('CONTINUITY'),
    eligibility_band: bandFor('ELIGIBILITY'),
    open_contradiction_count: evidence.filter((e) => e.current_status === 'CONTRADICTED').length,
    stale_evidence_count: evidence.filter((e) => e.current_status === 'STALE').length,
    has_open_dispute: evidence.some((e) => e.current_status === 'DISPUTED'),
    single_source_only,
    longitudinal_observed,
  };
}

// TR-5 B2 (DDR §4) — the why-path renderer (β1, Lead-ruled). Maps the thinness
// flags to the LOCKED assessment statements — strings only, NO digit, count, or
// ordinal ever. The fixed sentence set is the whole vocabulary; a reviewer with
// evidence access reads the underlying numbers in the ledger, never here. This is
// the renderer TR-14's contracted assessment surface will consume by name.
export const TRUST_STATEMENT_SINGLE_SOURCE = 'Evidence from a single source';
export const TRUST_STATEMENT_LONGITUDINAL = 'Observed over time';

export function deriveTrustStatements(state: {
  single_source_only: boolean;
  longitudinal_observed: boolean;
}): string[] {
  const statements: string[] = [];
  if (state.single_source_only) statements.push(TRUST_STATEMENT_SINGLE_SOURCE);
  if (state.longitudinal_observed) statements.push(TRUST_STATEMENT_LONGITUDINAL);
  return statements;
}
