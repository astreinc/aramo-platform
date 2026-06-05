import {
  COMPENSATION_SPREAD_SCOPES,
  COMPENSATION_VIEW_BILL,
  COMPENSATION_VIEW_MARGIN_PERCENT,
  COMPENSATION_VIEW_PAY,
  COMPENSATION_VIEW_REVENUE,
  COMPENSATION_VIEW_SPREAD_AMOUNT,
  COMPENSATION_VIEW_SPREAD_PERCENT,
} from './compensation-scope.js';

// AUTHZ-D5 — scope→field-set map + omit-by-scope.
//
// The mask is FIELD-OMISSION (per comp v1.1 §3 maskability — every comp
// field is `string | null` on read; the consumer cannot distinguish "no
// value stored" from "no value visible"). Omission = key absent from the
// JSON, NOT key-present-with-null. Implemented by `delete view[k]` on a
// shallow clone so JSON.stringify drops the key.
//
// Grouping rationale (the matrix-level call):
//   - view:pay groups pay_rate_* + salary_* — the talent-side
//     economics anchor on both CONTRACT and PERMANENT sides.
//   - view:bill groups bill_rate_* + placement_fee_* — the agency-
//     economics anchor on both sides.
//   - view:revenue is the bill_rate-only subset of view:bill — granted to
//     Finance/Exec/DM, who see "revenue" (the rate) but not the perm fee
//     (an AM concern). A role holding view:bill effectively also has
//     view:revenue's fields; granting both to AM is the matrix-intended
//     redundancy (semantic, not field-distinct on bill_rate_*).
//   - view:spread:amount, view:spread:percent, view:margin:percent each
//     gate ONE derived view independently — so a role can hold exactly
//     one spread scope without inverting bill_rate from spread + pay.
//
// THE ENFORCED INVARIANT (load-bearing): no role holds both view:pay AND
// any spread scope. assertNonInvertibleBundle proves this mechanically
// across every seeded bundle (see compensation-non-invertibility.spec).
// The percent-pair (markup% + margin%) alone is interconvertible but has
// no $ scale, so granting both percent scopes without a $ anchor is safe.
//
// compensation_model is NOT in the map — it's a discriminator label
// (CONTRACT / PERMANENT), not a $ value, always visible to anyone who
// can read the requisition.

// The 11 maskable comp fields on RequisitionView (comp v1.1 §2).
export const COMPENSATION_FIELD_KEYS = [
  'pay_rate_amount',
  'pay_rate_currency',
  'pay_rate_period',
  'bill_rate_amount',
  'bill_rate_currency',
  'bill_rate_period',
  'placement_fee_percent',
  'placement_fee_amount',
  'salary_amount',
  'salary_currency',
  'margin_amount',
  'markup_percent',
  'margin_percent',
] as const;

export type CompensationFieldKey = (typeof COMPENSATION_FIELD_KEYS)[number];

// Scope → the fields it grants visibility on. EITHER-grants: a field is
// visible if ANY held scope lists it.
const SCOPE_TO_FIELDS: Readonly<Record<string, readonly CompensationFieldKey[]>> = {
  [COMPENSATION_VIEW_PAY]: [
    'pay_rate_amount',
    'pay_rate_currency',
    'pay_rate_period',
    'salary_amount',
    'salary_currency',
  ],
  [COMPENSATION_VIEW_BILL]: [
    'bill_rate_amount',
    'bill_rate_currency',
    'bill_rate_period',
    'placement_fee_percent',
    'placement_fee_amount',
  ],
  [COMPENSATION_VIEW_REVENUE]: [
    'bill_rate_amount',
    'bill_rate_currency',
    'bill_rate_period',
  ],
  [COMPENSATION_VIEW_SPREAD_AMOUNT]: ['margin_amount'],
  [COMPENSATION_VIEW_SPREAD_PERCENT]: ['markup_percent'],
  [COMPENSATION_VIEW_MARGIN_PERCENT]: ['margin_percent'],
};

// Compute the set of comp fields the actor's scope-set makes visible. A
// field is visible iff at least one held scope lists it. Returns a Set
// for O(1) membership at the omit step. Unknown scopes are ignored
// (forward-compat: non-comp scopes don't affect this map).
export function visibleCompensationFields(
  scopes: Iterable<string>,
): Set<CompensationFieldKey> {
  const visible = new Set<CompensationFieldKey>();
  for (const scope of scopes) {
    const fields = SCOPE_TO_FIELDS[scope];
    if (fields === undefined) continue;
    for (const field of fields) visible.add(field);
  }
  return visible;
}

// Omit-by-scope: returns a SHALLOW CLONE of the view with comp fields the
// actor's scopes don't grant DELETED (so JSON.stringify drops them — the
// comp v1.1 §3 absent-from-JSON contract). Non-comp fields pass through
// untouched. compensation_model is preserved (discriminator label, not a
// $ value).
//
// Generic over T so callers don't lose the concrete view type at the
// call site. The contract: every CompensationFieldKey is optional on T
// (RequisitionView holds each as `string | null` which TypeScript widens
// to `string | null | undefined` after `delete`).
export function omitMaskedCompensationFields<T extends Record<string, unknown>>(
  view: T,
  scopes: Iterable<string>,
): T {
  const visible = visibleCompensationFields(scopes);
  const out: Record<string, unknown> = { ...view };
  for (const field of COMPENSATION_FIELD_KEYS) {
    if (!visible.has(field) && field in out) {
      delete out[field];
    }
  }
  return out as T;
}

// THE ENFORCED INVARIANT (the load-bearing §4 gate 1). Asserts that no
// (role, scope-set) bundle holds both view:pay AND any spread scope.
// Throws on violation with the offending role + the colliding scopes.
//
// This is the mechanical proof of the non-invertibility design: pay +
// any spread arithmetic reconstructs bill, so the two MUST NOT co-occur
// in any bundle (other than the see-all tier, which is allowed to hold
// every scope and is the I4 exception).
//
// Called from the seed.spec catalog test against every role bundle. The
// see-all tier (TA / TO / super_admin / Exec) bypasses the check by
// design (it holds view:pay + every spread scope; the "inversion" is
// not a leak when the role intentionally sees everything).
export function assertNonInvertibleBundle(
  roleKey: string,
  scopes: Iterable<string>,
  options: { seeAll?: boolean } = {},
): void {
  if (options.seeAll === true) return;
  const set = new Set(scopes);
  if (!set.has(COMPENSATION_VIEW_PAY)) return;
  const spreadHeld = COMPENSATION_SPREAD_SCOPES.filter((s) => set.has(s));
  if (spreadHeld.length === 0) return;
  throw new Error(
    `D5 non-invertibility violation: role "${roleKey}" holds compensation:view:pay AND spread scope(s) ${spreadHeld.join(
      ', ',
    )}. pay + spread reconstructs bill (the enforced invariant forbids this combination — see libs/field-masking).`,
  );
}
