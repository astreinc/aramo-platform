import { TRUST_BANDS, type TrustBand, type TrustDimension } from '@aramo/intelligence-contracts';

import type { TrustStateRow } from '../repositories/types.js';
import type { AssertionStatus } from '../vocabulary.js';

// ATI-SEP-1 T5 — trust band derivation against the Golden model. A port of the
// SPIRIT of libs/talent-trust band-derivation (no import of it — scope:cip is
// off-limits to scope:intelligence): four dimensions, five ordered bands,
// independence-weighted (never count-weighted), SELF never verifies, and an
// open contradiction caps a dimension at CORROBORATED. Pure, no I/O.
//
// Independence (ADR-0036): distinct source TENANTS count as corroboration, but
// repeated claims are NOT verification — every claim of one tenant collapses to
// one signal, every talent-self claim collapses to one SELF signal, and an
// AI-derived inference is never a source of its own.
//
// Band ladder per dimension (only VALID assertions raise a band):
//   NOT_ESTABLISHED        nothing contributes
//   SELF_ASSERTED          something is declared
//   CORROBORATED           >= 2 independent non-SELF sources, or document support,
//                          or a sender-verified identifier (IDENTITY)
//   INDEPENDENTLY_VERIFIED a TI verification (source_kind VERIFICATION / TI_ACQUIRED, VERIFIED)
//   AUTHORITATIVE          a VERIFIED TI-acquired assertion backed by an acquired artifact
// ELIGIBILITY additionally requires the TI-computed `authoritative` flag
// (résumé-sourced / AI-derived work authorization never rises above SELF_ASSERTED).

export interface TrustAssertion {
  id: string;
  assertion_type: string;
  payload: Record<string, unknown>;
  source_system_id: string;
  source_tenant_id: string | null;
  source_kind: string;
  verification_status: string;
  observed_at: Date;
  ai_derived: boolean;
  /** Status as seen in the current view (projection effective status). */
  status: AssertionStatus;
}

export interface TrustIdentifier {
  verification_status: string;
  /** NULL for a TI-originated identifier. */
  source_reference_id: string | null;
}

export const VERIFICATION_STALE_DAYS = 365;
const MS_PER_DAY = 86_400_000;

const bandOrder = (b: TrustBand): number => TRUST_BANDS.indexOf(b);
const atLeast = (current: TrustBand, floor: TrustBand): TrustBand => (bandOrder(floor) > bandOrder(current) ? floor : current);

const TI_SOURCE_KINDS = new Set(['VERIFICATION', 'TI_ACQUIRED']);

export function dimensionOf(a: Pick<TrustAssertion, 'assertion_type' | 'payload'>): TrustDimension {
  switch (a.assertion_type) {
    case 'NAME':
      return 'IDENTITY';
    case 'WORK_HISTORY':
    case 'EDUCATION':
      return 'CONTINUITY';
    case 'WORK_AUTHORIZATION':
      return 'ELIGIBILITY';
    case 'VERIFICATION_OUTCOME': {
      const target = a.payload['target'];
      if (target === 'EMAIL' || target === 'PHONE') return 'IDENTITY';
      if (target === 'EMPLOYMENT' || target === 'EDUCATION') return 'CONTINUITY';
      return 'CLAIMS';
    }
    default:
      return 'CLAIMS';
  }
}

/** The independence key of one assertion (see header). */
export function independenceKey(a: Pick<TrustAssertion, 'id' | 'source_kind' | 'source_system_id' | 'source_tenant_id'>): string {
  if (a.source_kind === 'TALENT_SELF') return 'SELF';
  if (TI_SOURCE_KINDS.has(a.source_kind)) return `ti:${a.source_kind}`;
  return `tenant:${a.source_system_id}:${a.source_tenant_id ?? ''}`;
}

function deriveBand(
  dimension: TrustDimension,
  assertions: TrustAssertion[],
  supported: ReadonlySet<string>,
  identifiers: TrustIdentifier[],
): TrustBand {
  const valid = assertions.filter((a) => a.status === 'VALID' && dimensionOf(a) === dimension);
  const senderVerifiedIdentifier =
    dimension === 'IDENTITY' && identifiers.some((i) => i.verification_status === 'VERIFIED' && i.source_reference_id !== null);
  if (valid.length === 0 && !senderVerifiedIdentifier) return 'NOT_ESTABLISHED';

  // ELIGIBILITY: only TI-authoritative work-authorization assertions may raise the band.
  const raising =
    dimension === 'ELIGIBILITY'
      ? valid.filter((a) => a.assertion_type !== 'WORK_AUTHORIZATION' || a.payload['authoritative'] === true)
      : valid;

  let band: TrustBand = 'SELF_ASSERTED';
  const sources = new Set(raising.filter((a) => !a.ai_derived && a.source_kind !== 'TALENT_SELF').map(independenceKey));
  const documentSupported = raising.some((a) => !a.ai_derived && a.verification_status === 'DOCUMENT_SUPPORTED');
  if (sources.size >= 2 || documentSupported || senderVerifiedIdentifier) band = atLeast(band, 'CORROBORATED');
  const tiVerified = raising.filter((a) => TI_SOURCE_KINDS.has(a.source_kind) && a.verification_status === 'VERIFIED');
  if (tiVerified.length > 0) band = atLeast(band, 'INDEPENDENTLY_VERIFIED');
  if (tiVerified.some((a) => a.source_kind === 'TI_ACQUIRED' && supported.has(a.id))) band = atLeast(band, 'AUTHORITATIVE');

  // Contradiction cap: an open contradiction in the dimension caps it at CORROBORATED.
  const contradicted = assertions.some((a) => a.status === 'CONTRADICTED' && dimensionOf(a) === dimension);
  if (contradicted && bandOrder(band) > bandOrder('CORROBORATED')) band = 'CORROBORATED';
  return band;
}

/**
 * Derive the trust state of one view of a subject (the full Golden set, or the
 * tenant-scoped set). `supported` = ids of assertions backed by an acquired artifact.
 */
export function deriveTrust(
  assertions: TrustAssertion[],
  identifiers: TrustIdentifier[],
  supported: ReadonlySet<string>,
  now: Date,
): TrustStateRow {
  const firstHand = assertions.filter((a) => a.status === 'VALID' && !a.ai_derived);
  const groups = new Set(firstHand.map(independenceKey));
  return {
    identity_band: deriveBand('IDENTITY', assertions, supported, identifiers),
    claims_band: deriveBand('CLAIMS', assertions, supported, identifiers),
    continuity_band: deriveBand('CONTINUITY', assertions, supported, identifiers),
    eligibility_band: deriveBand('ELIGIBILITY', assertions, supported, identifiers),
    open_contradiction_count: assertions.filter((a) => a.status === 'CONTRADICTED').length,
    stale_assertion_count: assertions.filter((a) => a.status === 'STALE').length,
    has_open_dispute: assertions.some((a) => a.status === 'DISPUTED'),
    single_source_only: groups.size === 1,
    verification_stale: assertions.some(
      (a) =>
        a.status === 'VALID' &&
        a.source_kind === 'VERIFICATION' &&
        now.getTime() - a.observed_at.getTime() > VERIFICATION_STALE_DAYS * MS_PER_DAY,
    ),
  };
}

export function sameTrust(a: TrustStateRow, b: TrustStateRow): boolean {
  return (
    a.identity_band === b.identity_band &&
    a.claims_band === b.claims_band &&
    a.continuity_band === b.continuity_band &&
    a.eligibility_band === b.eligibility_band &&
    a.open_contradiction_count === b.open_contradiction_count &&
    a.stale_assertion_count === b.stale_assertion_count &&
    a.has_open_dispute === b.has_open_dispute &&
    a.single_source_only === b.single_source_only &&
    a.verification_stale === b.verification_stale
  );
}
