// The ONE SIGN_DATE formatter (Aramo-Sign-Client-Rule-Consolidation-Directive-v1_0-LOCKED
// §2 C0-2, §4 C2-4). The server stamps SIGN_DATE with it in the signer's time zone; web and
// mobile use the same function for the preview. A client sends its IANA zone; anything the
// runtime does not recognise as a time zone falls back to UTC.

// M-A12 W1-E.2 — the date formats a sender may stamp on an envelope (audit row 33).
export const SIGN_DATE_FORMATS = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'] as const;
export type SignDateFormat = (typeof SIGN_DATE_FORMATS)[number];
export const DEFAULT_SIGN_DATE_FORMAT: SignDateFormat = 'MM/DD/YYYY';

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

/** This runtime's IANA time zone (the browser or device), or null when it reports none. */
export function localTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz !== '' ? tz : null;
  } catch {
    return null;
  }
}

/**
 * The client PREVIEW of the server's SIGN_DATE (C0-2): the same formatter the server stamps
 * with, applied to `now` in this runtime's time zone. The stored value is always the
 * server's, filled in at signing.
 */
export function signDatePreview(format: string | null | undefined, now: Date = new Date()): string {
  return formatSignDate(now, format, localTimeZone() ?? SIGN_DATE_FALLBACK_TIME_ZONE);
}
