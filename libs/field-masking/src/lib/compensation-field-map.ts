import {
  COMPENSATION_EDIT_PAY,
  COMPENSATION_SPREAD_SCOPES,
  COMPENSATION_VIEW_BILL,
  COMPENSATION_VIEW_MARGIN_PERCENT,
  COMPENSATION_VIEW_PAY,
  COMPENSATION_VIEW_REVENUE,
  COMPENSATION_VIEW_SPREAD_AMOUNT,
  COMPENSATION_VIEW_SPREAD_PERCENT,
} from './compensation-scope.js';
import { omitFieldsByScopeMap } from './omit-by-scope.js';

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
  return omitFieldsByScopeMap(view, scopes, SCOPE_TO_FIELDS);
}

// THE ENFORCED INVARIANT (the load-bearing §4 gate 1). Asserts that the
// (role, scope-set) bundle satisfies the non-invertibility design across
// BOTH the read side AND the read∪write-side write-then-derive threat.
// Throws on violation with the offending role + the colliding scopes.
//
// READ-SIDE (D5 original): pay + any spread arithmetic reconstructs
// bill, so view:pay MUST NOT co-occur with any spread VIEW scope in any
// bundle (other than the see-all tier).
//
// VIEW∪EDIT (D-AUTHZ-COMP-WRITE-1 extension — the write-then-derive
// channel): a user holding edit:pay alongside any spread VIEW scope can
// WRITE a known pay value then READ-derive the bill (margin_amount from
// pay+spread). Symmetric to the read-side leak — the gate must close
// it. edit:bill is safe alongside spread views (writing bill doesn't
// derive pay from a spread view; bill is the read input the spread view
// already reveals derivatively, no additional leak).
//
// Called from the seed.spec catalog test against every role bundle. The
// see-all tier (TA / TO / auditor_with_financials / super_admin)
// bypasses BOTH checks by design (it holds view:pay + edit:pay + every
// spread scope; the "inversion" is not a leak when the role
// intentionally sees everything).
export function assertNonInvertibleBundle(
  roleKey: string,
  scopes: Iterable<string>,
  options: { seeAll?: boolean } = {},
): void {
  if (options.seeAll === true) return;
  const set = new Set(scopes);
  const spreadHeld = COMPENSATION_SPREAD_SCOPES.filter((s) => set.has(s));
  if (spreadHeld.length === 0) return;
  // Read-side: view:pay + spread:* → derive bill from a viewed pay.
  if (set.has(COMPENSATION_VIEW_PAY)) {
    throw new Error(
      `D5 non-invertibility violation: role "${roleKey}" holds compensation:view:pay AND spread scope(s) ${spreadHeld.join(
        ', ',
      )}. pay + spread reconstructs bill (the enforced invariant forbids this combination — see libs/field-masking).`,
    );
  }
  // View∪edit: edit:pay + spread:* → write a known pay then derive bill.
  if (set.has(COMPENSATION_EDIT_PAY)) {
    throw new Error(
      `D-AUTHZ-COMP-WRITE-1 view∪edit non-invertibility violation: role "${roleKey}" holds compensation:edit:pay AND spread scope(s) ${spreadHeld.join(
        ', ',
      )}. Writing pay + reading spread reconstructs bill (the write-then-derive channel — see libs/field-masking).`,
    );
  }
}
