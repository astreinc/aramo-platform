// Search PR-2 — résumé re-extract queue constants. Mirrors the
// CANONICALIZATION_TRIGGER / OUTBOX_PUBLISHER queue-constants pattern (one
// source of truth shared by BullModule.registerQueue, the @Processor
// decorator, and the registration.ts getQueueToken caller).
//
// The polling-outbox shape: a `pending` talent_resume_text row IS the work-to-
// do signal (written synchronously at the résumé-attachment commit seam). The
// repeat-tick worker drains pending rows via ResumeTextService.drainPendingBatch
// — S3 fetch + deterministic extract + D4 redaction + persist. Redis-gated:
// inert in CI / Redis-less envs (the proofs call drainPendingBatch directly).
export const RESUME_REINDEX_QUEUE_NAME = 'resume-reindex' as const;

// Batch size per tick — bounded so a backlog burst does not hold the worker
// indefinitely. 50 mirrors the default drain limit.
export const RESUME_REINDEX_BATCH_SIZE = 50 as const;
