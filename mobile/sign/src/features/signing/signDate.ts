// Aramo-Sign-Client-Rule-Consolidation-Directive-v1_0-LOCKED §2 C0-2 — the server stamps
// the stored SIGN_DATE when the signer finishes: the signer's calendar date in their time
// zone, in the date format stamped on the envelope (MM/DD/YYYY when none). This app only
// shows a PREVIEW of that value and sends the device's IANA time zone when the signer finishes.
// §4 C2 — the preview formatter and the time-zone read are the shared ones in
// @aramo/sign-client (the same formatter the server stamps with); only the copy and the
// request-body shape below are this app's.
import { localTimeZone } from '@aramo/sign-client';

export const SIGN_DATE_PREVIEW_NOTE = 'filled in at signing';

/** `{ time_zone }` for a signing request body, or nothing when the zone is unknown. */
export function timeZoneBody(): { time_zone?: string } {
  const tz = localTimeZone();
  return tz ? { time_zone: tz } : {};
}
