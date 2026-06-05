// AUTHZ-D5 — compensation:view:* scope family.
//
// The 6-scope family that keys field-level compensation masking. Forced
// to be scope-keyed (not role-keyed) by the substrate: AuthContext carries
// `scopes: string[]` only — no role claim in the JWT.
//
// The masking is at the response layer (DDR D6) on the requisition read
// DTO. Field omission, not value-mangling — fields absent from the JSON,
// per the comp v1.1 §3 maskability design.
//
// THE ENFORCED INVARIANT (the load-bearing §4 gate 1): no role holds both
// `compensation:view:pay` AND any spread scope (the spread arithmetic
// reconstructs bill from pay + spread). Validated mechanically by
// assertNonInvertibleBundle.
//
// THE ACCEPTED-DERIVATION (soft, by-design — recorded for the close): AM
// + Exec can compute pay = bill − margin_amount when they hold view:bill +
// view:spread:amount. This is a UI default, not a security boundary —
// AM's incentive IS margin. Contrast EEO/Settings where the boundary will
// be hard (protected-class data structurally non-derivable).

export const COMPENSATION_VIEW_PAY = 'compensation:view:pay' as const;
export const COMPENSATION_VIEW_BILL = 'compensation:view:bill' as const;
export const COMPENSATION_VIEW_REVENUE = 'compensation:view:revenue' as const;
export const COMPENSATION_VIEW_SPREAD_AMOUNT =
  'compensation:view:spread:amount' as const;
export const COMPENSATION_VIEW_SPREAD_PERCENT =
  'compensation:view:spread:percent' as const;
export const COMPENSATION_VIEW_MARGIN_PERCENT =
  'compensation:view:margin:percent' as const;

export const COMPENSATION_VIEW_SCOPES = [
  COMPENSATION_VIEW_PAY,
  COMPENSATION_VIEW_BILL,
  COMPENSATION_VIEW_REVENUE,
  COMPENSATION_VIEW_SPREAD_AMOUNT,
  COMPENSATION_VIEW_SPREAD_PERCENT,
  COMPENSATION_VIEW_MARGIN_PERCENT,
] as const;

export type CompensationViewScope = (typeof COMPENSATION_VIEW_SCOPES)[number];

// The 3 spread scopes — any one of them combined with view:pay would
// reconstruct bill (pay + spread = bill), so the enforced invariant
// forbids the combination.
export const COMPENSATION_SPREAD_SCOPES = [
  COMPENSATION_VIEW_SPREAD_AMOUNT,
  COMPENSATION_VIEW_SPREAD_PERCENT,
  COMPENSATION_VIEW_MARGIN_PERCENT,
] as const;
