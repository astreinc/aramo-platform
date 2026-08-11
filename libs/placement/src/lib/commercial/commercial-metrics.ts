import { Prisma } from '../../../prisma/generated/client/client.js';

// Track 5 / T5-P2 — the ONE canonical backend derivation of assignment commercial
// metrics (Directive §14: T9 must NOT reimplement spread/margin/markup). Exported
// from @aramo/placement, exactly like deriveCapacity — reporting (T9) already
// depends on @aramo/placement, so it consumes this without a new nx edge.
//
// The math is byte-identical to the ratified requisition derivation
// (compensation-views.ts §2.2 / DEC-5): all arithmetic is Prisma.Decimal — NEVER
// float (33.33% must not drift). Percentages are scale-2 decimal strings.
//
//   spread          = bill - pay
//   margin_percent  = bill == 0 ? null : (spread / bill) * 100   (denominator = bill)
//   markup_percent  = pay  == 0 ? null : (spread / pay)  * 100   (denominator = pay)
//
// Zero-denominator (Directive §7, following compensation-views): a valid persisted
// pay=0 / bill=0 yields a null percentage — NEVER Infinity / NaN, NEVER a throw.
// spread always computes.

export type CommercialMetrics = {
  readonly spread_amount: string;
  readonly margin_percent: string | null;
  readonly markup_percent: string | null;
};

export function deriveCommercialMetrics(
  pay: Prisma.Decimal,
  bill: Prisma.Decimal,
): CommercialMetrics {
  const spread = bill.minus(pay);
  const zero = new Prisma.Decimal(0);
  const hundred = new Prisma.Decimal(100);

  const spread_amount = spread.toFixed(2);
  const markup_percent = pay.equals(zero)
    ? null
    : spread.div(pay).times(hundred).toFixed(2);
  const margin_percent = bill.equals(zero)
    ? null
    : spread.div(bill).times(hundred).toFixed(2);

  return { spread_amount, margin_percent, markup_percent };
}
