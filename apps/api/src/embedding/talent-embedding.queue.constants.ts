// Enterprise Search GS-2A Slice-5b — the talent-embedding worker queue constants. One source of
// truth for BullModule.registerQueue, the @Processor decorator, and the getQueueToken caller in the
// SCHEDULES registrar (registration.ts). The tick drives the DARK reconcile sweep + the lifecycle
// drain; both are additionally gated by EMBEDDING_PROCESSING_ENABLED, so an enabled Redis alone does
// nothing until the flag is on (and the PROD pgvector runtime is attested + the migration applied).
export const TALENT_EMBEDDING_QUEUE_NAME = 'talent-embedding' as const;

// 300s tick — embedding freshness is search-infra, not sub-minute urgent; the reconcile enqueues
// only new live Talents and the worker's idempotency short-circuits unchanged ones.
export const TALENT_EMBEDDING_TICK_INTERVAL_MS = 300_000 as const;
