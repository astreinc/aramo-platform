// Pure (no Nest, no Prisma): the server's SIGN_DATE value.
// Aramo-Sign-Client-Rule-Consolidation-Directive-v1_0-LOCKED §2 C0-2 — the server stamps
// SIGN_DATE in the signer's time zone. A client sends its IANA zone; anything the runtime
// does not recognise as a time zone falls back to UTC.
export const SIGN_DATE_FALLBACK_TIME_ZONE = 'UTC';
const TIME_ZONE_SHAPE = /^[A-Za-z0-9_+\-/]{1,64}$/;
let supportedZones: ReadonlySet<string> | null = null;

function isSupportedTimeZone(tz: string): boolean {
  if (supportedZones === null) {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    supportedZones = new Set(typeof intl.supportedValuesOf === 'function' ? intl.supportedValuesOf('timeZone') : []);
  }
  if (supportedZones.has(tz)) return true;
  // Intl.supportedValuesOf lists canonical zones only; a valid alias or UTC (for example
  // "Asia/Calcutta", which some devices report) is accepted when Intl resolves it.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The signer's IANA time zone when valid, else UTC. Never throws. */
export function resolveSignerTimeZone(input: unknown): string {
  if (typeof input !== 'string') return SIGN_DATE_FALLBACK_TIME_ZONE;
  const tz = input.trim();
  if (!TIME_ZONE_SHAPE.test(tz)) return SIGN_DATE_FALLBACK_TIME_ZONE;
  return isSupportedTimeZone(tz) ? tz : SIGN_DATE_FALLBACK_TIME_ZONE;
}

function calendarDateIn(d: Date, timeZone: string): { yyyy: string; mm: string; dd: string } {
  if (timeZone === SIGN_DATE_FALLBACK_TIME_ZONE) {
    return { yyyy: String(d.getUTCFullYear()), mm: String(d.getUTCMonth() + 1).padStart(2, '0'), dd: String(d.getUTCDate()).padStart(2, '0') };
  }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return { yyyy: part('year').padStart(4, '0'), mm: part('month').padStart(2, '0'), dd: part('day').padStart(2, '0') };
}

/**
 * Formats the calendar date of `d` in one of the supported Sign date formats, as seen in
 * `timeZone` (default UTC, so existing callers are unchanged). An unrecognised zone is
 * treated as UTC; an unknown or null format uses DEFAULT_SIGN_DATE_FORMAT (MM/DD/YYYY).
 */
export function formatSignDate(d: Date, format: string | null | undefined, timeZone: string = SIGN_DATE_FALLBACK_TIME_ZONE): string {
  const { yyyy, mm, dd } = calendarDateIn(d, resolveSignerTimeZone(timeZone));
  if (format === 'DD/MM/YYYY') return `${dd}/${mm}/${yyyy}`;
  if (format === 'YYYY-MM-DD') return `${yyyy}-${mm}-${dd}`;
  return `${mm}/${dd}/${yyyy}`;
}
