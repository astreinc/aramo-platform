// Hand-mirrored from libs/field-masking/src/lib/compensation-field-map.ts.
// R4's D5 DEFENSIVE FE (ruling 1, Frame B) — the form shows only the
// compensation fields the actor's view-scopes grant, and submits only
// those same fields (omit-not-null on PATCH so a no-view:pay recruiter
// editing a req does NOT BLANK the comp data they can't see).
//
// The BE has NO compensation write-side scope gate today; this map is
// the FE-side floor until D-AUTHZ-COMP-WRITE-1 (the carry) lands a real
// in-service write gate. The hand-mirror is annotated; if the BE adds a
// new scope or changes the mapping, the FE must follow.
//
// compensation_model is NOT in this map — it's a discriminator label,
// always visible to anyone who can read the requisition (mirrors the
// BE comment at compensation-field-map.ts:39-41).

export type CompensationFieldKey =
  | 'pay_rate_amount'
  | 'pay_rate_currency'
  | 'pay_rate_period'
  | 'bill_rate_amount'
  | 'bill_rate_currency'
  | 'bill_rate_period'
  | 'placement_fee_percent'
  | 'placement_fee_amount'
  | 'salary_amount'
  | 'salary_currency';

// The 10 maskable + WRITABLE comp fields (the 3 derived — margin_amount /
// markup_percent / margin_percent — are computed; not writable from the
// form). The BE's COMPENSATION_FIELD_KEYS list includes those 3; the form
// only sends the 10 the recruiter can author.

const SCOPE_TO_FIELDS: Readonly<Record<string, readonly CompensationFieldKey[]>> = {
  'compensation:view:pay': [
    'pay_rate_amount',
    'pay_rate_currency',
    'pay_rate_period',
    'salary_amount',
    'salary_currency',
  ],
  'compensation:view:bill': [
    'bill_rate_amount',
    'bill_rate_currency',
    'bill_rate_period',
    'placement_fee_percent',
    'placement_fee_amount',
  ],
  'compensation:view:revenue': [
    'bill_rate_amount',
    'bill_rate_currency',
    'bill_rate_period',
  ],
  // The spread scopes grant DERIVED-view visibility (margin_amount /
  // markup_percent / margin_percent) — none of which are form-writable.
  // Listed for completeness; they grant zero writable-field visibility.
  'compensation:view:spread:amount': [],
  'compensation:view:spread:percent': [],
  'compensation:view:margin:percent': [],
};

export function visibleWritableCompensationFields(
  scopes: readonly string[],
): ReadonlySet<CompensationFieldKey> {
  const out = new Set<CompensationFieldKey>();
  for (const scope of scopes) {
    const fields = SCOPE_TO_FIELDS[scope];
    if (fields === undefined) continue;
    for (const f of fields) out.add(f);
  }
  return out;
}

// True iff any compensation:view:* scope is held. When false, the entire
// compensation section is hidden (no fields → no UX value).
export function hasAnyCompensationViewScope(scopes: readonly string[]): boolean {
  for (const s of scopes) {
    if (s in SCOPE_TO_FIELDS) return true;
  }
  return false;
}
