// Canonical civil-day (app-timezone) date math — the ONE home for timezone-aware
// "what calendar day is this instant on" and "how many whole calendar days apart".
//
// Business semantics across the platform (My Desk urgency/aging, client waiting
// age, interview-today) MUST agree on the civil day in the application timezone,
// never a raw UTC day and never absolute-ms division (the §38 trap: both DST and
// the UTC/local split make `Math.floor(ms / DAY)` wrong at the edges). Consumers
// derive those semantics from these primitives; they never re-implement the math.
//
// Pure, deterministic, no I/O — `now` is always injected by the caller so every
// derived semantic stays unit-testable without a clock.

const DAY_MS = 86_400_000;

// The application timezone — the single "basis" every civil-day business semantic
// (urgency, aging, waiting age, interview-today) resolves against. Read once, here,
// so controllers don't each re-read the env var with their own default literal.
export const DEFAULT_APP_TIME_ZONE = 'America/New_York';

export function resolveAppTimeZone(): string {
  return process.env['ARAMO_APP_TIME_ZONE'] ?? DEFAULT_APP_TIME_ZONE;
}

// The UTC anchor (00:00:00Z) of the CIVIL date that `ms` falls on in `timeZone`.
// Anchoring each civil date to UTC-midnight makes both day comparison and
// whole-day differences exact across DST and across the UTC/local split — never
// Date.getUTCDate() on raw ms. en-CA formats as YYYY-MM-DD.
export function civilDayUtcMs(ms: number, timeZone: string): number {
  const ymd = isoDateInTimeZone(ms, timeZone);
  return Date.parse(`${ymd}T00:00:00Z`);
}

// YYYY-MM-DD civil date in `timeZone`.
export function isoDateInTimeZone(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

// Whole calendar days elapsed between `sinceMs` and `nowMs` in the app timezone.
// Clamped at 0 (a same-day or future instant is 0 days).
export function agingDaysInTimeZone(
  sinceMs: number,
  nowMs: number,
  timeZone: string,
): number {
  const days = Math.round(
    (civilDayUtcMs(nowMs, timeZone) - civilDayUtcMs(sinceMs, timeZone)) / DAY_MS,
  );
  return Math.max(0, days);
}
