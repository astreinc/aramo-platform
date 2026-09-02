import Decimal from 'decimal.js';

// Lane 7 / L7-D — THE ONE canonical commercial arithmetic authority. Both the
// assignment commercial ledger (libs/placement) and the requisition compensation
// plan (libs/requisition) derive spread/margin/markup from THIS pure function, so the
// math can never drift between the two domains. It lives in the neutral @aramo/common
// (both already depend on it) rather than forcing a requisition -> placement edge.
//
// Operates on Decimal(12,2) money STRINGS — decoupled from any generated Prisma client's
// Decimal type. All arithmetic is decimal.js (the same engine Prisma.Decimal wraps),
// NEVER float. Percentages are scale-2 decimal strings; a zero denominator yields null,
// NEVER Infinity / NaN / a throw. spread always computes.
//
//   spread          = bill - pay
//   margin_percent  = bill == 0 ? null : (spread / bill) * 100   (denominator = bill)
//   markup_percent  = pay  == 0 ? null : (spread / pay)  * 100   (denominator = pay)

export type CommercialMetrics = {
  readonly spread_amount: string;
  readonly margin_percent: string | null;
  readonly markup_percent: string | null;
};

export function deriveCommercialMetrics(pay: string, bill: string): CommercialMetrics {
  const p = new Decimal(pay);
  const b = new Decimal(bill);
  const spread = b.minus(p);
  const zero = new Decimal(0);
  const hundred = new Decimal(100);

  return {
    spread_amount: spread.toFixed(2),
    markup_percent: p.equals(zero) ? null : spread.div(p).times(hundred).toFixed(2),
    margin_percent: b.equals(zero) ? null : spread.div(b).times(hundred).toFixed(2),
  };
}
