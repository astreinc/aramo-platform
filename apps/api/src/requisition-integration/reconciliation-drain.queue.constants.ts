// CB-D2-R (ADR-0030) — the reconciliation-drain queue constants. One source of
// truth for BullModule.registerQueue, the @Processor decorator, and the
// getQueueToken caller in the SCHEDULES registrar (registration.ts). Placed in
// apps/api (composition root) per the connector-in-app ruling: the drain worker
// composes the requisition command seam + the integration reconciliation queue,
// so it lives at the app root (both libs are scope:ats; no I15 edge).
export const RECONCILIATION_DRAIN_QUEUE_NAME = 'reconciliation-drain' as const;

// The drain cadence — every 300s (matching the lifecycle-poll sweep). A pending
// reconciliation row is not sub-minute urgent, and the backoff watermark spaces
// re-attempts; a 5-minute drain is ample.
export const RECONCILIATION_DRAIN_INTERVAL_MS = 300_000 as const;

// Rows claimed per tick — bounded so a backlog burst never holds the worker.
export const RECONCILIATION_DRAIN_BATCH_SIZE = 100 as const;

// The bounded re-attempt cap. A RE_EVALUABLE row that keeps refusing (CAS race /
// still-unmappable / transient) OR an INTERVENTION row is bumped+backed-off until
// attempts reaches this cap, then PARKED (poison) — never re-picked by the poll.
export const RECONCILIATION_DRAIN_MAX_ATTEMPTS = 5 as const;

// The lease horizon a claim stamps into locked_until — long enough to out-live one
// drain of a batch; an abandoned lease (crashed worker) expires and the row is
// re-claimable.
export const RECONCILIATION_DRAIN_LEASE_MS = 300_000 as const;

// The backoff applied when a still-retryable row is rescheduled (next_attempt_at =
// now + this). Spaces CAS/transient re-attempts without a spin loop.
export const RECONCILIATION_DRAIN_BACKOFF_MS = 60_000 as const;
