// M365-SCHED-1 PR 1B (FIX_NOW-1/2) — timezone-correct conversion between a recruiter's
// wall-clock date/time in a selected IANA zone and unambiguous ISO-8601 instants, with
// no external dependency (uses the built-in Intl tz database). The backend/Graph accept
// an offset-bearing ISO-8601 instant; a bare `YYYY-MM-DDTHH:mm:ss` is NOT unambiguous.
// DST nonexistent (spring-forward gap) and ambiguous (fall-back overlap) local times are
// detected and surfaced rather than silently resolved to an incorrect instant.

export type WallClockProblem = 'none' | 'nonexistent' | 'ambiguous';

export interface InstantResult {
  readonly startIso: string;
  readonly endIso: string;
  readonly problem: WallClockProblem;
}

/** The zone's offset east-of-UTC, in minutes, at the given absolute instant. */
function zoneOffsetMinutes(instantMs: number, zone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(instantMs))) parts[p.type] = p.value;
  const asIfUtc = Date.UTC(
    Number(parts['year']), Number(parts['month']) - 1, Number(parts['day']),
    Number(parts['hour']), Number(parts['minute']), Number(parts['second']),
  );
  return Math.round((asIfUtc - instantMs) / 60000);
}

function pad(n: number, w = 2): string {
  return String(Math.abs(n)).padStart(w, '0');
}

function formatOffset(offsetMin: number): string {
  const sign = offsetMin < 0 ? '-' : '+';
  return `${sign}${pad(Math.trunc(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
}

/** Format an absolute instant as an offset-bearing ISO-8601 string in the given offset. */
function toIsoWithOffset(instantMs: number, offsetMin: number): string {
  const local = new Date(instantMs + offsetMin * 60000);
  return (
    `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    formatOffset(offsetMin)
  );
}

interface Resolved { instantMs: number; offsetMin: number; problem: WallClockProblem; }

const DAY_MS = 86_400_000;

/** Resolve a wall-clock date/time in `zone` to an absolute instant, flagging DST edges. */
function resolveWallClock(date: string, time: string, zone: string): Resolved {
  const [ys, mos, ds] = date.split('-');
  const [hs, mis] = time.split(':');
  const y = Number.parseInt(ys ?? '', 10);
  const mo = Number.parseInt(mos ?? '', 10);
  const d = Number.parseInt(ds ?? '', 10);
  const h = Number.parseInt(hs ?? '', 10);
  const mi = Number.parseInt(mis ?? '', 10);
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, 0);

  // The two offsets in effect around this date (differ only across a DST transition).
  const offsetSamples = new Set<number>([
    zoneOffsetMinutes(wallAsUtc, zone),
    zoneOffsetMinutes(wallAsUtc - DAY_MS, zone),
    zoneOffsetMinutes(wallAsUtc + DAY_MS, zone),
  ]);

  // An offset is a VALID interpretation iff applying it yields an instant that reads
  // back as the same wall clock in this zone. Overlap → ≥2 valid distinct instants
  // (ambiguous); gap → 0 valid (nonexistent); normal → exactly 1.
  const validInstants: { instantMs: number; offsetMin: number }[] = [];
  const seen = new Set<number>();
  for (const off of offsetSamples) {
    const instantMs = wallAsUtc - off * 60000;
    if (zoneOffsetMinutes(instantMs, zone) === off && !seen.has(instantMs)) {
      seen.add(instantMs);
      validInstants.push({ instantMs, offsetMin: off });
    }
  }

  if (validInstants.length === 0) {
    // Nonexistent (spring-forward gap): no offset round-trips. Best-effort instant for
    // display, but the caller must treat `nonexistent` as a blocking validation error.
    const off = zoneOffsetMinutes(wallAsUtc, zone);
    return { instantMs: wallAsUtc - off * 60000, offsetMin: off, problem: 'nonexistent' };
  }
  // Earliest occurrence is the conventional pick; ambiguity is still surfaced.
  validInstants.sort((a, b) => a.instantMs - b.instantMs);
  const chosen = validInstants[0];
  if (chosen === undefined) {
    const off = zoneOffsetMinutes(wallAsUtc, zone);
    return { instantMs: wallAsUtc - off * 60000, offsetMin: off, problem: 'nonexistent' };
  }
  return {
    instantMs: chosen.instantMs,
    offsetMin: chosen.offsetMin,
    problem: validInstants.length >= 2 ? 'ambiguous' : 'none',
  };
}

export function composeInstants(
  date: string,
  time: string,
  durationMin: number,
  zone: string,
): InstantResult {
  const start = resolveWallClock(date, time, zone);
  const endMs = start.instantMs + durationMin * 60000;
  const endOffset = zoneOffsetMinutes(endMs, zone);
  return {
    startIso: toIsoWithOffset(start.instantMs, start.offsetMin),
    endIso: toIsoWithOffset(endMs, endOffset),
    problem: start.problem,
  };
}

/** Render a stored ISO instant as the wall-clock date/time of the selected zone. */
export function instantToZonedWallClock(iso: string, zone: string): { date: string; time: string } {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return { date: '', time: '' };
  const offset = zoneOffsetMinutes(ms, zone);
  const local = new Date(ms + offset * 60000);
  return {
    date: `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
    time: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
  };
}

export function durationMinutesBetween(startIso: string, endIso: string): number {
  const a = new Date(startIso).getTime();
  const b = new Date(endIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 30;
  return Math.round((b - a) / 60000);
}
