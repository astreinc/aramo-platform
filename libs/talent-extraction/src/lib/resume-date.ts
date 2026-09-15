// HF2 date-precision ruling — experience-duration math must operate ONLY on
// normalized, confidence-safe dates. NO loose `new Date(freeform)` ever feeds a
// supported-years calculation: `new Date("2021")` silently fabricates
// 2021-01-01 and `new Date("Summer 2021")` is runtime-dependent garbage. This
// parser instead recognizes a CLOSED set of résumé date shapes and REFUSES
// everything else (→ null = UNKNOWN/UNPARSEABLE), carrying the PRECISION so a
// year-only "2021" is never silently promoted to an exact day.

export type ResumeDatePrecision = 'EXACT' | 'MONTH' | 'YEAR';

export interface ResumeDate {
  readonly year: number;
  readonly month: number | null; // 1–12, null at YEAR precision
  readonly day: number | null; // 1–31, null at MONTH/YEAR precision
  readonly precision: ResumeDatePrecision;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const ONGOING = new Set([
  'present', 'current', 'now', 'ongoing', 'to date', 'till date', 'todate', 'date',
]);

/** True when the raw token means "still ongoing" (an open-ended interval end). */
export function isOngoingDateToken(raw: string): boolean {
  return ONGOING.has(raw.trim().toLowerCase());
}

function valid(year: number, month: number | null, day: number | null): boolean {
  if (year < 1900 || year > 2100) return false;
  if (month !== null && (month < 1 || month > 12)) return false;
  if (day !== null && (day < 1 || day > 31)) return false;
  return true;
}

/**
 * Strict résumé-date parse. Recognizes ONLY: YYYY-MM-DD (EXACT), YYYY-MM /
 * MM/YYYY / "Mon YYYY" (MONTH), YYYY (YEAR). Returns null for anything
 * ambiguous or unparseable ("Summer 2021", "early 2020", free text) — NEVER a
 * guessed date. Ongoing tokens ("present") are NOT dates — use isOngoingDateToken.
 */
export function parseResumeDate(raw: string): ResumeDate | null {
  const s = raw.trim();
  if (s === '' || isOngoingDateToken(s)) return null;

  let m: RegExpMatchArray | null;

  // EXACT — YYYY-MM-DD
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return valid(year, month, day) ? { year, month, day, precision: 'EXACT' } : null;
  }
  // MONTH — YYYY-MM
  if ((m = s.match(/^(\d{4})-(\d{2})$/))) {
    const [year, month] = [Number(m[1]), Number(m[2])];
    return valid(year, month, null) ? { year, month, day: null, precision: 'MONTH' } : null;
  }
  // MONTH — MM/YYYY
  if ((m = s.match(/^(\d{1,2})\/(\d{4})$/))) {
    const [month, year] = [Number(m[1]), Number(m[2])];
    return valid(year, month, null) ? { year, month, day: null, precision: 'MONTH' } : null;
  }
  // MONTH — "Mon YYYY" / "Month YYYY" (optional trailing dot on abbrev)
  if ((m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{4})$/))) {
    const month = MONTHS[m[1]!.toLowerCase()];
    const year = Number(m[2]);
    if (month !== undefined && valid(year, month, null)) {
      return { year, month, day: null, precision: 'MONTH' };
    }
    return null;
  }
  // YEAR — YYYY
  if ((m = s.match(/^(\d{4})$/))) {
    const year = Number(m[1]);
    return valid(year, null, null) ? { year, month: null, day: null, precision: 'YEAR' } : null;
  }
  // Anything else is NOT confidence-safe — refuse it.
  return null;
}

// The coarsest precision wins when spans of mixed precision are combined (a
// derived duration is only as trustworthy as its least-precise input).
const PRECISION_ORDER: Record<ResumeDatePrecision, number> = { EXACT: 0, MONTH: 1, YEAR: 2 };
export function coarsestPrecision(a: ResumeDatePrecision, b: ResumeDatePrecision): ResumeDatePrecision {
  return PRECISION_ORDER[a] >= PRECISION_ORDER[b] ? a : b;
}

// Month index (year*12 + 0-based month) for interval math. `edge` disambiguates
// a coarse date's boundary WITHOUT fabricating a day: a YEAR-precision start is
// January, a YEAR-precision end is December; a MONTH/EXACT date uses its month.
// The APPROXIMATION is explicit + carried as precision — never presented as exact.
export function resumeDateToMonthIndex(d: ResumeDate, edge: 'start' | 'end'): number {
  const month = d.month ?? (edge === 'start' ? 1 : 12);
  return d.year * 12 + (month - 1);
}
