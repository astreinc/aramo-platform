// Lane 2 / L2-G (Part 3) — the placement→pipeline lifecycle orchestrator queue
// constants. One source of truth for BullModule.registerQueue, the @Processor
// decorator, and the getQueueToken caller in the SCHEDULES registrar. Placed in
// apps/api (composition root) per the connector-in-app ruling: the orchestrator
// composes the pipeline command seam + the bridge inbox + a raw cross-schema
// read of placement.OutboxEvent — all scope:ats, no I15 edge.
export const PLACEMENT_LIFECYCLE_QUEUE_NAME = 'placement-lifecycle-orchestration' as const;

// The drain cadence — every 300s (matching the other lifecycle sweeps). A placement
// state-change is not sub-minute urgent; a 5-minute drain is ample and the pending
// rows are retried on the next tick.
export const PLACEMENT_LIFECYCLE_INTERVAL_MS = 300_000 as const;

// Events claimed per tick — bounded so a backlog burst never holds the worker.
export const PLACEMENT_LIFECYCLE_BATCH_SIZE = 100 as const;
