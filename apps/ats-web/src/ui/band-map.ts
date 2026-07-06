// Presentation-band tint + label mapping for trust bands (BandPill).
//
// The canonical band vocabulary is PRESENTATION_BANDS in
// libs/talent-trust/src/lib/vocab.ts. ats-web is untagged and MUST NOT import
// the scope:cip talent-trust lib (the I15 CIP⊥ATS wall), so this is a
// hand-mirror — band-map.spec.ts asserts it matches the wire contract's ordered
// set so a new BE band can never silently fall through (the stage-map precedent).
//
// It adds only the PRESENTATIONAL projection the Confident Blue system needs:
// a per-band StatusPill tone + the human label BandPill renders. R10: trust is
// a per-dimension BAND (label), never a number or a star — this file maps a
// band to a colour+label, never to a numeric rating.

import type { PillTone } from './pills';

// Hand-mirror of libs/talent-trust PRESENTATION_BANDS, ORDERED low→high.
export const PRESENTATION_BANDS = [
  'NOT_ESTABLISHED',
  'SELF_ASSERTED',
  'CORROBORATED',
  'INDEPENDENTLY_VERIFIED',
  'AUTHORITATIVE',
] as const;

export type PresentationBand = (typeof PRESENTATION_BANDS)[number];

// BAND-PILL SEMANTICS (Lead directive): NOT_ESTABLISHED = neutral ·
// SELF_ASSERTED = warn · CORROBORATED = info · INDEPENDENTLY_VERIFIED = ok ·
// AUTHORITATIVE = brand. Rising trust reads cool→confident, never a rating.
const BAND_TONE: Record<PresentationBand, PillTone> = {
  NOT_ESTABLISHED: 'neutral',
  SELF_ASSERTED: 'warn',
  CORROBORATED: 'info',
  INDEPENDENTLY_VERIFIED: 'ok',
  AUTHORITATIVE: 'brand',
};

const BAND_LABEL: Record<PresentationBand, string> = {
  NOT_ESTABLISHED: 'Not established',
  SELF_ASSERTED: 'Self-asserted',
  CORROBORATED: 'Corroborated',
  INDEPENDENTLY_VERIFIED: 'Independently verified',
  AUTHORITATIVE: 'Authoritative',
};

function isKnownBand(band: string): band is PresentationBand {
  return (PRESENTATION_BANDS as readonly string[]).includes(band);
}

// A subject with no TrustState yet has a null band — the directive guard: render
// it as "Not established" / neutral (nothing is established, not "unknown").
// An unrecognised future band degrades gracefully to neutral + a humanised label
// (never a raw SNAKE_CASE enum to the user, never a number).
export function bandTone(band: string | null): PillTone {
  if (band === null || !isKnownBand(band)) return 'neutral';
  return BAND_TONE[band];
}

export function bandLabel(band: string | null): string {
  if (band === null) return BAND_LABEL.NOT_ESTABLISHED;
  if (isKnownBand(band)) return BAND_LABEL[band];
  return humanise(band);
}

function humanise(raw: string): string {
  const lower = raw.toLowerCase().replace(/_/g, ' ').trim();
  if (lower.length === 0) return 'Not established';
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
