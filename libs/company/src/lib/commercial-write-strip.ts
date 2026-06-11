// Company-Fields v1.1 — the Company COMMERCIAL write-side scope gate.
//
// Mirrors the STRUCTURE of libs/requisition/.../compensation-edit-gate.ts
// (the established write-side comp pattern) but with STRIP, not 403,
// semantics — per Amendment v1.1 R2/R3: commercial fields are pre-fill
// DEFAULTS, "write follows read", and a non-holder edit must "never null an
// existing commercial value". So a non-holder POST/PATCH carrying commercial
// fields has those fields SILENTLY REMOVED before persist (the rest of the
// payload still saves); on UPDATE the repository sets only present keys, so a
// stripped commercial field is left untouched (existing value preserved).
//
// SCOPE-KEY DUPLICATION (load-bearing): the literal below MUST match
// libs/field-masking COMPANY_READ_COMMERCIAL verbatim. libs/company does NOT
// import @aramo/field-masking — field-masking is the TERMINAL lib (the
// dependency direction is apps/api → field-masking only). The local literal
// mirrors the same discipline the requisition compensation-edit-gate uses for
// the compensation:edit:* constants, and the scope.dto.ts SEED_SCOPE_KEYS
// literal.
const COMPANY_READ_COMMERCIAL = 'company:read_commercial' as const;

// The 6 gated commercial write-fields (mirror libs/field-masking
// COMPANY_COMMERCIAL_FIELD_KEYS; one atomic group — read-all-or-none, so
// write-all-or-none-stripped).
export const COMPANY_COMMERCIAL_WRITE_KEYS = [
  'fee_model',
  'default_contract_markup_pct',
  'default_perm_fee_pct',
  'payment_terms',
  'credit_status',
  'default_currency',
] as const;

// Returns the input unchanged when the actor holds company:read_commercial;
// otherwise returns a SHALLOW CLONE with the commercial keys removed (set to
// undefined-by-deletion), so the repository's present-key-only writes never
// persist or null them. Called at the repository write boundary (create /
// createForImport / update) BEFORE building the Prisma data.
export function stripUnscopedCommercialFields<T>(
  input: T,
  scopes: readonly string[],
): T {
  if (scopes.includes(COMPANY_READ_COMMERCIAL)) return input;
  const out = { ...(input as Record<string, unknown>) };
  for (const key of COMPANY_COMMERCIAL_WRITE_KEYS) {
    if (key in out) delete out[key];
  }
  return out as T;
}
