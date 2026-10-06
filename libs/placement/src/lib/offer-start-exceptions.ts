// Canonical offer-start EXCEPTION semantic — the ONE derivation of the live
// "needs attention" conditions on the offer→start journey, from the authoritative
// owner states. Owned here because both Offer and PlacementProcess are placement
// aggregates. Consumers (the Offer & Start worklist, the Talent Journey read, the
// Offer & Start journey FE) read this result and its canonical labels; none
// re-decides `offer === EXPIRED` / `offer === DECLINED` / `placement === BLOCKED`
// nor invents an alternate label for the same reason.
//
// This is the LIVE-condition exception set (what needs attention). It is distinct
// from: (1) the offer-TIMING semantic (expiring/expired-by-time from expires_at —
// see offer-timing.ts); (2) the granular FAILED pre-start requirement rows
// (pre-start-requirement deriveBlockers), which a consumer may render in place of
// the coarse pre_start_blocked when it has them.

import type { OfferState } from './lifecycle/offer-lifecycle.js';
import type { PlacementState } from './lifecycle/placement-lifecycle.js';

export type OfferStartExceptionKind =
  | 'offer_expired'
  | 'offer_declined'
  | 'pre_start_blocked';

export interface OfferStartException {
  readonly kind: OfferStartExceptionKind;
  readonly label: string;
  readonly detail: string;
}

export function deriveOfferStartExceptions(args: {
  readonly offer_state: OfferState | string | null;
  readonly placement_state: PlacementState | string | null;
}): readonly OfferStartException[] {
  const out: OfferStartException[] = [];
  if (args.offer_state === 'EXPIRED') {
    out.push({
      kind: 'offer_expired',
      label: 'Offer expired',
      detail: 'The offer expired before it was signed.',
    });
  }
  if (args.offer_state === 'DECLINED') {
    out.push({
      kind: 'offer_declined',
      label: 'Offer declined',
      detail: 'The talent declined the offer.',
    });
  }
  if (args.placement_state === 'BLOCKED') {
    out.push({
      kind: 'pre_start_blocked',
      label: 'Pre-start blocked',
      detail: 'A required pre-start requirement failed — start is blocked until resolved.',
    });
  }
  return out;
}
