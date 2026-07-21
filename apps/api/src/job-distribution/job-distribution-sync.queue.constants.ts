// SRC-2 PR-3 (R4) — the job-distribution freshness-sweep queue constants. One
// source of truth for BullModule.registerQueue, the @Processor decorator, and the
// getQueueToken caller in the SCHEDULES registrar (registration.ts). Placed in
// apps/api (NOT the lib) per the PRIMARY ruling + the match-sweep precedent: the
// sweep orchestration injects RequisitionRepository, so it lives at the
// composition root and libs/job-distribution stays buildable-import-free.
export const JOB_DISTRIBUTION_SYNC_QUEUE_NAME = 'job-distribution-sync' as const;

// Per-tick TOTAL mutation budget (create + update + expire), shared across all
// tenants in a tick. Derived CONSERVATIVELY from Indeed's documented LARGE tier
// (>10 jobs/request: 1/sec, 40/min, 200/10min, 800/hr) because our assigned tier
// is unknown until certification (RECON-1: "Indeed assigns each client a tier and
// rate limit"). At the 5-minute cadence, 50/tick = 600/hr < 800/hr and, across any
// two ticks, 100/10min < 200/10min — headroom on every window. Serial execution at
// <= 1/sec drains a full budget in ~50s, far inside the 300s tick.
export const JOB_DISTRIBUTION_PER_TICK_MUTATION_CAP = 50 as const;

// The create-specific backfill sub-cap (scope-4: <= 100 creates/tick). The total
// mutation budget above is stricter, so creates are bounded by it in practice;
// this constant records the directive's explicit create cap for the day the total
// budget is raised post-certification.
export const JOB_DISTRIBUTION_BACKFILL_CREATE_CAP = 100 as const;
