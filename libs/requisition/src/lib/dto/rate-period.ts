// RatePeriod — Compensation-Field Modeling v1.1 §2.1 closed list. The
// period unit for pay_rate / bill_rate. The derived-view compute in
// projectView (margin_amount, markup_percent, margin_percent) returns
// null when bill_rate_period !== pay_rate_period (proof 13 — a
// mismatch is not a crash).
export const RATE_PERIOD_VALUES = [
  'HOURLY',
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'ANNUAL',
] as const;
export type RatePeriod = (typeof RATE_PERIOD_VALUES)[number];

export function isRatePeriod(value: unknown): value is RatePeriod {
  return (
    typeof value === 'string' &&
    (RATE_PERIOD_VALUES as readonly string[]).includes(value)
  );
}
