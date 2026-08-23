import type { OfferState } from './types';

// Offer Lifecycle (D7) — the ONE canonical offer-state → label map the panel
// consumes. Presentation-only; the value space is the drift-guarded FE mirror.
export const RECRUITING_OFFER_STATE_LABELS: Record<OfferState, string> = {
  DRAFT: 'Draft',
  SENT: 'Sent',
  NEGOTIATION: 'In negotiation',
  ACCEPTED: 'Accepted',
  DECLINED: 'Declined',
  EXPIRED: 'Expired',
  RESCINDED: 'Rescinded',
};
