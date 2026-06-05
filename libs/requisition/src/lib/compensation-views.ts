import { Prisma } from '../../prisma/generated/client/client.js';

import type { RatePeriod } from './dto/rate-period.js';

// Compensation-Field Modeling v1.1 §2.2 — the three derived views.
// PURE functions of the two stored facts (bill_rate, pay_rate). NOT
// stored as columns (§10 halt: storing them re-introduces drift —
// editing bill independently from pay would leave a stored margin
// stale). Each view is computed-on-read in projectView and exposed as
// an independent optional read field so D5 can per-role mask any one
// of them without leaking the masked rate by inversion (§3
// reconciliation).
//
// The PO's worked example (proof 11): pay=60, bill=80 →
// margin_amount=20, markup_percent=33.33, margin_percent=25.
//
// All arithmetic is Prisma.Decimal — NOT float (§10 halt: 33.33%
// must not drift). The returned values are decimal strings to match
// the storage representation (Prisma serializes Decimal as string at
// the API boundary; preserving that contract here keeps the read DTO
// homogeneous: every Decimal-shaped field is a string-or-null).

type DecimalLike = Prisma.Decimal;

export interface CompensationFactsInput {
  pay_rate_amount: DecimalLike | null;
  pay_rate_currency: string | null;
  pay_rate_period: RatePeriod | null;
  bill_rate_amount: DecimalLike | null;
  bill_rate_currency: string | null;
  bill_rate_period: RatePeriod | null;
}

export interface DerivedViews {
  margin_amount: string | null;
  markup_percent: string | null;
  margin_percent: string | null;
}

const NULL_VIEWS: DerivedViews = {
  margin_amount: null,
  markup_percent: null,
  margin_percent: null,
};

// Compute the three derived views from the two stored facts. Returns
// all-null when either rate is incomplete (missing amount / currency
// / period) OR the two rates do not share currency + period (§2.2
// guard / proof 13 — a mismatch is not a crash). Individual views
// turn null when their specific divisor is zero (markup needs
// pay > 0; margin% needs bill > 0); margin_amount always computes
// when both amounts are present (and the guards above pass).
export function computeDerivedViews(
  facts: CompensationFactsInput,
): DerivedViews {
  const {
    pay_rate_amount: pay,
    pay_rate_currency: payCcy,
    pay_rate_period: payPeriod,
    bill_rate_amount: bill,
    bill_rate_currency: billCcy,
    bill_rate_period: billPeriod,
  } = facts;

  if (pay === null || bill === null) return NULL_VIEWS;
  if (payCcy === null || billCcy === null) return NULL_VIEWS;
  if (payPeriod === null || billPeriod === null) return NULL_VIEWS;
  if (payCcy !== billCcy) return NULL_VIEWS;
  if (payPeriod !== billPeriod) return NULL_VIEWS;

  const spread = bill.minus(pay);
  const zero = new Prisma.Decimal(0);
  const hundred = new Prisma.Decimal(100);

  const margin_amount = spread.toFixed(2);
  const markup_percent = pay.equals(zero)
    ? null
    : spread.div(pay).times(hundred).toFixed(2);
  const margin_percent = bill.equals(zero)
    ? null
    : spread.div(bill).times(hundred).toFixed(2);

  return { margin_amount, markup_percent, margin_percent };
}
