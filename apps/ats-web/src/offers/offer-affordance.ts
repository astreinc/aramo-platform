import type { OfferState } from './types';

// Offer Lifecycle (D7) — the named offer affordances the panel renders, computed
// purely from (current offer state × actor scopes). COSMETIC: the BE fail-closed
// offer-lifecycle policy + the DB lifecycle trigger are authoritative (a
// scope-less or illegal transition is refused regardless of what the UI shows).
// The edges mirror the BE governingOfferAction map.

export type OfferAction = 'SEND' | 'NEGOTIATE' | 'REVISE' | 'ACCEPT' | 'DECLINE' | 'EXPIRE' | 'RESCIND';

export interface OfferAffordance {
  readonly action: OfferAction;
  readonly label: string;
  readonly toState: OfferState;
}

const OFFER_TRANSITION = 'offer:transition';

// Per-state affordance list, in the BE edge order.
const BY_STATE: Partial<Record<OfferState, readonly OfferAffordance[]>> = {
  DRAFT: [
    { action: 'SEND', label: 'Send', toState: 'SENT' },
    { action: 'RESCIND', label: 'Rescind', toState: 'RESCINDED' },
  ],
  SENT: [
    { action: 'NEGOTIATE', label: 'Negotiate', toState: 'NEGOTIATION' },
    { action: 'ACCEPT', label: 'Accept', toState: 'ACCEPTED' },
    { action: 'DECLINE', label: 'Decline', toState: 'DECLINED' },
    { action: 'EXPIRE', label: 'Expire', toState: 'EXPIRED' },
    { action: 'RESCIND', label: 'Rescind', toState: 'RESCINDED' },
  ],
  NEGOTIATION: [
    { action: 'REVISE', label: 'Revise', toState: 'SENT' },
    { action: 'ACCEPT', label: 'Accept', toState: 'ACCEPTED' },
    { action: 'DECLINE', label: 'Decline', toState: 'DECLINED' },
    { action: 'EXPIRE', label: 'Expire', toState: 'EXPIRED' },
    { action: 'RESCIND', label: 'Rescind', toState: 'RESCINDED' },
  ],
};

export function offerActionsFor(
  state: OfferState,
  scopes: readonly string[],
): OfferAffordance[] {
  if (!scopes.includes(OFFER_TRANSITION)) return [];
  return [...(BY_STATE[state] ?? [])];
}
