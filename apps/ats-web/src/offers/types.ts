// Offer Lifecycle (D7) — the FE mirror of the BE OfferState value space
// (libs/placement/src/lib/lifecycle/offer-lifecycle.ts OFFER_STATES). ats-web
// cannot import @aramo/placement (a forbidden domain edge), so the value space is
// hand-mirrored; keep it 1:1 with the BE registry.
export const OFFER_STATES = [
  'DRAFT',
  'SENT',
  'NEGOTIATION',
  'ACCEPTED',
  'DECLINED',
  'EXPIRED',
  'RESCINDED',
] as const;
export type OfferState = (typeof OFFER_STATES)[number];
