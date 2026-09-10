// CI-B6P §20 — the CI-processing queue constants (one source of truth for
// BullModule.registerQueue, @InjectQueue, and the @Processor decorator). The
// queue is enqueue-driven (per-run work), not a global SCHEDULES sweep; a
// self-scheduled repeatable `reconcile` job on the SAME queue drives recovery
// (so the global registration.ts is untouched).

export const CI_PROCESSING_QUEUE_NAME = 'ci-processing' as const;

/** Per-run work job (payload = identifiers only). */
export const CI_PROCESSING_RUN_JOB = 'run' as const;

/** Repeatable recovery job (re-drives queued/failed_retryable runs). */
export const CI_PROCESSING_RECONCILE_JOB = 'reconcile' as const;

/** Recovery cadence — 300s, matching the other Aramo sweeps. Idempotent. */
export const CI_PROCESSING_RECONCILE_INTERVAL_MS = 300_000 as const;

/** Fixed repeatable jobId so BullMQ dedups the reconcile tick across restarts. */
export const CI_PROCESSING_RECONCILE_JOB_ID = 'ci-processing-reconcile' as const;

/** Max runs re-driven per reconcile tick (bounded — never an unbounded scan). */
export const CI_PROCESSING_RECONCILE_BATCH = 100 as const;

/**
 * The BullMQ job payload — IDENTIFIERS ONLY (directive §20). Never any
 * transcript text, prompt, snapshot body, provider response, or secret.
 */
export interface CiProcessingJobData {
  readonly run_id: string;
  readonly tenant_id: string;
}
