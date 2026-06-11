// Company-Fields v1.1 — company commercial field masking.
//
// The SECOND consumer of the field-masking mechanism (after AUTHZ-D5
// compensation). Mirrors compensation-field-map.ts EXACTLY in shape:
//   - a scope→field-set map,
//   - omit-by-DELETE (key absent from JSON, NOT key-present-with-null —
//     `delete view[k]` on a shallow clone),
//   - keyed on a single scope.
//
// Difference from compensation: company commercial fields are DEFAULTS that
// pre-fill a requisition/placement (not the source-of-truth for revenue), so
// the domain has no see-but-not-edit distinction — ONE scope
// `company:read_commercial` gates BOTH read (this omit) and write (the
// company-local repository strip). Hence no view/edit pair, no
// non-invertibility invariant (a single all-or-nothing group cannot be
// inverted from a partial held set).
//
// Terminal-lib discipline preserved: no entity lib imports this; the apps/api
// interceptor calls it, exactly as for compensation.

export const COMPANY_READ_COMMERCIAL = 'company:read_commercial' as const;

// The 6 gated commercial fields on CompanyView (Company-Fields v1.1 §1 File 1).
export const COMPANY_COMMERCIAL_FIELD_KEYS = [
  'fee_model',
  'default_contract_markup_pct',
  'default_perm_fee_pct',
  'payment_terms',
  'credit_status',
  'default_currency',
] as const;

export type CompanyCommercialFieldKey =
  (typeof COMPANY_COMMERCIAL_FIELD_KEYS)[number];

// Omit-by-scope: returns a SHALLOW CLONE of the view with the commercial
// fields DELETED when the actor's scope-set lacks company:read_commercial
// (so JSON.stringify drops the keys — the absent-from-JSON contract). A
// holder gets every commercial field; a non-holder gets none of them. All
// six fields are one atomic group (read-all-or-none).
export function omitMaskedCommercialFields<T extends Record<string, unknown>>(
  view: T,
  scopes: Iterable<string>,
): T {
  const held = new Set(scopes);
  if (held.has(COMPANY_READ_COMMERCIAL)) return view;
  const out: Record<string, unknown> = { ...view };
  for (const field of COMPANY_COMMERCIAL_FIELD_KEYS) {
    if (field in out) delete out[field];
  }
  return out as T;
}
