// Monthly billing periods aligned to a subscription's anchor instant (UTC).
// Period k starts at anchor + k calendar months, keeping the anchor's time of day;
// the day is clamped to the month's length (an anchor on the 31st renews on the
// 30th in April and the 28th/29th in February). Included allowance never rolls
// over: each period is counted on its own.

export interface BillingPeriod {
  readonly start: Date;
  readonly end: Date;
}

export function addMonthsClamped(anchor: Date, months: number): Date {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth() + months;
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const daysInTarget = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(anchor.getUTCDate(), daysInTarget);
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

/** The monthly period containing `at`. Before the anchor, the first period. */
export function billingPeriodAt(anchor: Date, at: Date): BillingPeriod {
  if (at.getTime() < anchor.getTime()) {
    return { start: anchor, end: addMonthsClamped(anchor, 1) };
  }
  let k =
    (at.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (at.getUTCMonth() - anchor.getUTCMonth());
  if (addMonthsClamped(anchor, k).getTime() > at.getTime()) k -= 1;
  return { start: addMonthsClamped(anchor, k), end: addMonthsClamped(anchor, k + 1) };
}
