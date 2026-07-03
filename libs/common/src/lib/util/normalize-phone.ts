// Deterministic phone normalization for within-tenant identity anchoring
// (TR-2a-1). Decision 10: matching inputs are normalized deterministically —
// NO LLM, NO probabilistic parsing.
//
// Ruling: DIGIT-STRIP (drop every non-digit), dependency-free. Deliberately NOT
// libphonenumber / E.164 — those are looser (they reconcile country codes and
// formats, widening equality) on the false-merge-critical matcher path, and add
// a dependency. Digit-strip is the STRICTER, safer key: two numbers match only
// if their digit sequences are identical. `+1 (555) 123-4567` → `15551234567`;
// `555-123-4567` → `5551234567` — these do NOT match (split-bias: a missed
// merge is recoverable; a wrong merge conflates two humans).

/**
 * Normalize a phone identifier to its digit sequence for within-tenant match
 * equality. Returns '' when the input carries no digits (callers skip empties).
 */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D+/g, '');
}
