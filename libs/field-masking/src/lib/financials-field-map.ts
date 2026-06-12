// Job-Module — requisition financial-planning field masking.
//
// The THIRD consumer of the field-masking mechanism (after AUTHZ-D5
// compensation and Company-Fields v1.1 commercial). Like commercial, it is
// a single-scope all-or-nothing group: ONE scope `requisition:view:financials`
// gates the whole field set; a holder sees every financial field, a
// non-holder sees none. No view/edit pair, no non-invertibility invariant
// (a single atomic group cannot be inverted from a partial held set).
//
// DELIBERATELY SEPARATE from the D5 compensation non-invertibility family.
// These are financial-PLANNING fields on a requisition (the target margin /
// markup the recruiter plans to, the rate-card reference, and the planned
// bill/pay rate bands) — NOT the compensation-of-record whose pay/bill/spread
// interconvertibility D5 guards. They carry their OWN scope and OWN field
// set: holding `requisition:view:financials` says nothing about the D5
// compensation scopes and vice versa, so the spread-vs-pay inversion gate
// (assertNonInvertibleBundle) neither covers nor is weakened by these fields.
//
// Mirrors commercial-field-map.ts in shape and delegates to the promoted
// omitFieldsByScopeMap helper. Terminal-lib discipline preserved: no entity
// lib imports this; the apps/api interceptor calls it.

import { omitFieldsByScopeMap } from './omit-by-scope.js';

export const REQUISITION_VIEW_FINANCIALS = 'requisition:view:financials' as const;

// The 7 gated financial-planning fields on RequisitionView.
export const REQUISITION_FINANCIAL_FIELD_KEYS = [
  'target_margin_percent',
  'markup_percent_target',
  'rate_card_id',
  'min_bill_rate',
  'max_bill_rate',
  'min_pay_rate',
  'max_pay_rate',
] as const;

export type RequisitionFinancialFieldKey =
  (typeof REQUISITION_FINANCIAL_FIELD_KEYS)[number];

// Omit-by-scope: returns a SHALLOW CLONE of the view with the financial
// fields DELETED when the actor's scope-set lacks requisition:view:financials
// (so JSON.stringify drops the keys — the absent-from-JSON contract). A
// holder gets every financial field; a non-holder gets none of them. All
// seven fields are one atomic group (read-all-or-none).
export function omitMaskedFinancialFields<T extends Record<string, unknown>>(
  view: T,
  scopes: Iterable<string>,
): T {
  return omitFieldsByScopeMap(view, scopes, {
    [REQUISITION_VIEW_FINANCIALS]: REQUISITION_FINANCIAL_FIELD_KEYS,
  });
}
