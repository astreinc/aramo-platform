// rate_type closed-set guard — Requisition Record Spec Amendment v1.0.
//
// The worker-classification of a requisition's bill rate. String-not-enum
// (convention R7 — the allowlist may evolve without a migration); validated
// at the controller boundary against this closed set (VALIDATION_ERROR on
// miss), mirroring the ISO-4217 currency guard. Stored as TEXT in DB.
//
// The FE mirrors this list (RATE_TYPE_VALUES) with a drift-guard spec.

export const RATE_TYPE_VALUES = ['C2C', 'W2', '1099', 'Any'] as const;

export type RateType = (typeof RATE_TYPE_VALUES)[number];

export function isRateType(value: string): value is RateType {
  return (RATE_TYPE_VALUES as readonly string[]).includes(value);
}
