// E-Sign OC v2 (DEC-A) — outbound-delivery backoff schedule, keyed by the
// attempt_count AFTER the just-failed attempt. The first delivery is immediate
// (an unpublished row has next_attempt_at = NULL); thereafter:
//   attempt 1 failed -> +30s
//   attempt 2 failed -> +2m
//   attempt 3 failed -> +10m
//   attempt 4+ failed -> capped at +30m
// Pure function; the precise schedule is implementation-level policy. Retries
// must not hammer the consumer every few seconds indefinitely.
const SCHEDULE_MS = [30_000, 120_000, 600_000];
const MAX_MS = 1_800_000;

export function backoffMs(attemptCount: number): number {
  if (attemptCount <= 0) return 0;
  return SCHEDULE_MS[attemptCount - 1] ?? MAX_MS;
}
