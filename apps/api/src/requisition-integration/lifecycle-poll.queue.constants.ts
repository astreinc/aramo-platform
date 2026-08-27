// CB-D2-A1 (ADR-0030, R-PRODUCER) — the lifecycle-poll queue constants. One source
// of truth for BullModule.registerQueue, the @Processor decorator, and the
// getQueueToken caller in the SCHEDULES registrar (registration.ts). Placed in
// apps/api (composition root) per the connector-in-app ruling: the poll producer
// injects the requisition + integration seams, so it lives at the app root.
export const LIFECYCLE_POLL_QUEUE_NAME = 'lifecycle-poll' as const;

// The poll cadence — every 300s (matching the job-distribution sweep). Lifecycle
// state changes are not sub-minute urgent, and the ledger dedups re-observations,
// so a 5-minute watermark advance is ample. Provider-specific cadence tuning is a
// later (real-adapter) slice.
export const LIFECYCLE_POLL_INTERVAL_MS = 300_000 as const;
