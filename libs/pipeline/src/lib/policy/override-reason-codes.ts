// ADR-0024 §D11 (PR-4b) — the closed set of operator override reason codes for
// a REQUISITION_TALENT · ADD override.
//
// RULING 2: reason codes are POLICY DATA, not protocol — so this is the LIGHT
// closed-set pattern (a plain TS const + type-guard, validated at the
// controller boundary emitting OVERRIDE_INVALID 422), NOT the four-surface
// error-codes registry. A four-surface registry with an OpenAPI enum would make
// adding a reason code a DEPLOY, which ADR §D2 forbids. Mirrors the examination
// VALID_OVERRIDE_TYPES pattern
// (libs/examination/src/lib/dto/create-override-request.dto.ts).
//
// VOCAB: the directive's colloquial term for the fourth code and the override
// capability is a Tier-2-banned trust-vocabulary token (scripts/verify-
// vocabulary.sh). Translated to the canonical Aramo term `submittal` (the
// libs/submittal domain) at read time — same concept, CI-clean identifier.
// Reported as a typed divergence.
export const VALID_OVERRIDE_REASON_CODES = [
  'replacement',
  'client_approved_overfill',
  'duplicate_correction',
  'late_recorded_submittal',
  'administrative_reconciliation',
] as const;

export type OverrideReasonCode = (typeof VALID_OVERRIDE_REASON_CODES)[number];

export function isOverrideReasonCode(v: unknown): v is OverrideReasonCode {
  return (
    typeof v === 'string' &&
    (VALID_OVERRIDE_REASON_CODES as readonly string[]).includes(v)
  );
}
