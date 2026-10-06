// Canonical offer-timing semantic — the ONE interpretation of an Offer's
// (state, offer_expires_at, now) for the recruiter surfaces: is it awaiting a
// response, is it expiring soon, has it passed its expiry, and how many days are
// left. Consumers (My Desk, the Requisition Workspace offers read) read this
// result; they do NOT re-decide the expirable state set nor recompute the window.
//
// Age/window are whole CIVIL days in the app timezone (the shared @aramo/common
// primitive) — never absolute-ms division. "Expired state" (OfferState === EXPIRED)
// is a SEPARATE recorded fact owned by the offer lifecycle / the expiry sweep; this
// helper interprets the expires_at TIMESTAMP for offers still awaiting a response.
//
// Document/e-sign signing semantics are intentionally NOT here — offer signing is
// owned by Documents/E-sign; this helper only reads Offer.state + offer_expires_at.

import { agingDaysInTimeZone, civilDayUtcMs } from '@aramo/common';

import {
  OFFER_STATES,
  isLegalOfferTransition,
  type OfferState,
} from './lifecycle/offer-lifecycle.js';

// A v1 PRODUCT DEFAULT warning horizon (not a domain invariant) — defined once here
// so it is never scattered across TS/UI.
export const DEFAULT_OFFER_EXPIRY_WARNING_DAYS = 7;

// The offer states that can expire — DERIVED from the lifecycle (the states from
// which the EXPIRE edge is legal), so it cannot drift from the state machine. Today
// this is { SENT, NEGOTIATION }: a DRAFT has not been sent (cannot be "awaiting a
// response"), and terminal offers cannot expire.
export const EXPIRABLE_OFFER_STATES: readonly OfferState[] = OFFER_STATES.filter(
  (s) => isLegalOfferTransition(s, 'EXPIRED'),
);

const EXPIRABLE_SET: ReadonlySet<string> = new Set<string>(EXPIRABLE_OFFER_STATES);

export interface OfferTiming {
  /** The offer is open and awaiting a talent response (an expirable state). */
  readonly awaiting_response: boolean;
  /** Awaiting response, expiry known, not past, and within the warning window. */
  readonly expiring_soon: boolean;
  /** Awaiting response and the expiry civil-day is before today (overdue). */
  readonly expired_by_time: boolean;
  /** Signed whole civil days until expiry (negative when past); null if N/A. */
  readonly days_until_expiry: number | null;
}

const NOT_TIMED: OfferTiming = {
  awaiting_response: false,
  expiring_soon: false,
  expired_by_time: false,
  days_until_expiry: null,
};

export function deriveOfferTiming(args: {
  readonly state: OfferState | string | null;
  readonly offer_expires_at: Date | string | null;
  readonly now_ms: number;
  readonly time_zone: string;
  readonly warning_days?: number;
}): OfferTiming {
  if (typeof args.state !== 'string' || !EXPIRABLE_SET.has(args.state)) return NOT_TIMED;
  const expMs =
    args.offer_expires_at === null
      ? null
      : args.offer_expires_at instanceof Date
        ? args.offer_expires_at.getTime()
        : Date.parse(args.offer_expires_at);
  if (expMs === null || Number.isNaN(expMs)) {
    return { awaiting_response: true, expiring_soon: false, expired_by_time: false, days_until_expiry: null };
  }
  const warning = args.warning_days ?? DEFAULT_OFFER_EXPIRY_WARNING_DAYS;
  // Signed civil-day delta: civilDay(expiry) - civilDay(now).
  const daysUntil = Math.round(
    (civilDayUtcMs(expMs, args.time_zone) - civilDayUtcMs(args.now_ms, args.time_zone)) / 86_400_000,
  );
  const expired_by_time = daysUntil < 0;
  // agingDaysInTimeZone(now, expiry) == max(0, daysUntil) for a non-past expiry.
  const daysAhead = agingDaysInTimeZone(args.now_ms, expMs, args.time_zone);
  return {
    awaiting_response: true,
    expiring_soon: !expired_by_time && daysAhead <= warning,
    expired_by_time,
    days_until_expiry: daysUntil,
  };
}
