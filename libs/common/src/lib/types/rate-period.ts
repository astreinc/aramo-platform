// Canonical shared RatePeriod closed list (Track 5 Amendment A2: libs/common is
// the single backend home for rate-period semantics). The period unit for a
// pay/bill rate. Consumed by libs/requisition (compensation fields) and
// libs/placement (assignment rate versions) without either lib depending on the
// other. A closed value list, NOT a Postgres enum (no DB enum merely for
// sharing). The values are preserved EXACTLY as the prior libs/requisition
// authority (A2-4: no expansion/rename).
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
