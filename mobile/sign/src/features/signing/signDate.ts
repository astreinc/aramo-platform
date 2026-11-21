// Aramo-Sign-Client-Rule-Consolidation-Directive-v1_0-LOCKED §2 C0-2 — the server stamps
// the stored SIGN_DATE when the signer finishes: the signer's calendar date in their time
// zone, in the date format stamped on the envelope (MM/DD/YYYY when none). This app only
// shows a PREVIEW of that value and sends the device's IANA time zone when the signer finishes.

export const SIGN_DATE_PREVIEW_NOTE = 'filled in at signing';

/** The preview of the server's SIGN_DATE: today on this device, in the envelope's format. */
export function signDatePreview(format: string | null | undefined, now: Date = new Date()): string {
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  if (format === 'DD/MM/YYYY') return `${d}/${m}/${y}`;
  if (format === 'YYYY-MM-DD') return `${y}-${m}-${d}`;
  return `${m}/${d}/${y}`;
}

/** The device's IANA time zone, or null when the runtime does not report one. */
export function deviceTimeZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === 'string' && tz !== '' ? tz : null;
  } catch {
    return null;
  }
}

/** `{ time_zone }` for a signing request body, or nothing when the zone is unknown. */
export function timeZoneBody(): { time_zone?: string } {
  const tz = deviceTimeZone();
  return tz ? { time_zone: tz } : {};
}
