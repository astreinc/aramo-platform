// Track 7 / T7-P3 — the closed, code-owned guarantee-terms provenance source registry
// (directive §3.6). Exactly the two governed source types. NO premature CLIENT_CONTRACT
// or RATE_CARD — a future client-contract source defaults into a term version by COPY,
// never a live link, and lands with its own increment. Stored as TEXT (+ a DB CHECK) on
// both the version row and the copied PermanentPlacement snapshot: the code-owned registry
// is validated at the write boundary (the permanent-falloff-reasons / AssignmentRateVersion
// currency precedent — no Postgres enum, the registry evolves in code).
export const GUARANTEE_TERMS_SOURCE_TYPES = ['MANUAL', 'IMPORTED'] as const;

export type GuaranteeTermsSourceType = (typeof GUARANTEE_TERMS_SOURCE_TYPES)[number];

export function isGuaranteeTermsSourceType(value: unknown): value is GuaranteeTermsSourceType {
  return typeof value === 'string' && (GUARANTEE_TERMS_SOURCE_TYPES as readonly string[]).includes(value);
}
