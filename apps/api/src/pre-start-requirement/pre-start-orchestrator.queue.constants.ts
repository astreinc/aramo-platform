// Lane 5 / L5-P1 (E2 ignition) — the pre-start orchestrator queue constants. One
// source of truth for BullModule.registerQueue, the @Processor decorator, and the
// getQueueToken caller in the SCHEDULES registrar. Placed in apps/api (composition
// root) per the connector-in-app ruling: the orchestrator composes the E2
// materialize/cancel/reconcile seams + a raw cross-schema read of
// placement.OutboxEvent — all scope:ats, no I15 edge.
export const PRE_START_ORCHESTRATOR_QUEUE_NAME = 'pre-start-orchestration' as const;

// The drain cadence — every 60s, matching RECONCILE_INTERVAL_MS. In the normal path
// materialize/cancel are driven by this tick; a placement born at PRE_START waits at
// most one interval before its requirement snapshot exists. 60s bounds worst-case
// "preparing" latency at negligible poll cost (see pre-start-materialization.service).
export const PRE_START_ORCHESTRATOR_INTERVAL_MS = 60_000 as const;

// Events/intents claimed per tick — bounded so a backlog burst never holds the worker.
export const PRE_START_ORCHESTRATOR_BATCH_SIZE = 100 as const;

// A dedicated system principal for the pre-start orchestrator — the governed caller
// of the E2 cancellation seam on a placement terminal. Fixed UUID (audit-stable),
// not a tenant user; the cancellation records it as actor_id with actor_type 'system'.
export const PRE_START_ORCHESTRATOR_SYSTEM_ACTOR_ID =
  '01900000-0000-7000-8000-000000000006' as const;
