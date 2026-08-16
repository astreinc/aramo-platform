// Track 7 / T7-P2 — the closed governed vocabulary for a qualifying PermanentPlacement
// falloff (directive §3.1). A DEDICATED T7 code-owned registry — NOT the Track-3
// pre-start FELL_THROUGH taxonomy (post-start guarantee falloff is a distinct concept)
// and NOT a Postgres enum (persisted as TEXT on PermanentPlacement.falloff_reason,
// mirroring the T6-B3 closed-TEXT-with-code-registry house shape). Kept in
// @aramo/placement so BOTH the write boundary (PermanentPlacementRepository) and the
// HTTP DTO draw from the SAME source — there is no second list.
//
// Exact-code matching only; NO `OTHER` in P2 (§3.1). A governed code may enter the
// outbox (§3.9); free text may not (there is no reason-detail column).

// The seven canonical P2 falloff reasons (§3.1). Order is presentation-stable.
export const PERMANENT_FALLOFF_REASON_CODES = [
  'TALENT_RESIGNED',
  'CLIENT_TERMINATED_PERFORMANCE',
  'CLIENT_TERMINATED_CONDUCT',
  'CLIENT_TERMINATED_BUSINESS_NEED',
  'MUTUAL_SEPARATION',
  'JOB_ABANDONMENT',
  'EMPLOYMENT_INELIGIBILITY',
] as const;

export type PermanentFalloffReasonCode = (typeof PERMANENT_FALLOFF_REASON_CODES)[number];

// True only for one of the seven governed codes. Any unknown string returns false
// (fail-closed — the caller raises PERMANENT_PLACEMENT_FALLOFF_REASON_INVALID). No OTHER.
export function isPermanentFalloffReasonCode(value: unknown): value is PermanentFalloffReasonCode {
  return (
    typeof value === 'string' &&
    (PERMANENT_FALLOFF_REASON_CODES as readonly string[]).includes(value)
  );
}
