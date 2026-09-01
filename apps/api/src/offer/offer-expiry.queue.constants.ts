// L4 / P6 — offer auto-expiry queue constants. One source of truth for
// BullModule.registerQueue, the @Processor decorator, and the getQueueToken caller
// in the SCHEDULES registrar (jobs/registration.ts). Mirrors the lifecycle-poll /
// job-distribution-sync sweep convention.
export const OFFER_EXPIRY_QUEUE_NAME = 'offer-expiry' as const;

// The sweep cadence — every 300s (matching the other Aramo sweeps). Offer expiry is
// not sub-minute urgent (offer_expires_at is a coarse deadline) and the sweep is
// idempotent, so a 5-minute tick is ample.
export const OFFER_EXPIRY_INTERVAL_MS = 300_000 as const;

// The system principal recorded as the actor on an auto-expiry OfferEvent — the
// sweep is system-initiated, with no user actor (the canonical all-zeros system id).
export const OFFER_EXPIRY_SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000' as const;
