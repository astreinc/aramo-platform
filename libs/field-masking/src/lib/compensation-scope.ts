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

// D-AUTHZ-COMP-WRITE-1 — compensation:edit:* scope family.
//
// The WRITE-side floor that closes the D5 write-path circumvention. The
// read-side enforces field omission on the response DTO; the write-side
// enforces scope-gating on the requisition write methods (create / update
// / createForImport) at the repository boundary. Two scopes — exactly
// the writeable surface:
//   - edit:pay  → pay_rate_amount/currency/period + salary_amount/currency
//   - edit:bill → bill_rate_amount/currency/period + placement_fee_*
// The 4 other view-side scopes (revenue / spread:amount / spread:percent
// / margin:percent) gate read-only DERIVED fields (computed in projectView
// from the two stored facts) — no writeable surface, no edit scope.
//
// THE WRITE-THEN-DERIVE THREAT: a user holding edit:pay + a spread VIEW
// scope can WRITE a known pay then READ-derive the bill via the spread
// view. assertNonInvertibleBundle's view∪edit extension forbids this
// combination across the bundle. The see-all bypass set (TA / TO /
// auditor_with_financials / super_admin) is unchanged.

export const COMPENSATION_EDIT_PAY = 'compensation:edit:pay' as const;
export const COMPENSATION_EDIT_BILL = 'compensation:edit:bill' as const;

export const COMPENSATION_EDIT_SCOPES = [
  COMPENSATION_EDIT_PAY,
  COMPENSATION_EDIT_BILL,
] as const;

export type CompensationEditScope = (typeof COMPENSATION_EDIT_SCOPES)[number];
