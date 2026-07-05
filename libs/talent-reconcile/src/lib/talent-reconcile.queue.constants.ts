// Promotion Gate Slice-B1 — reconcile poll queue constants. Mirrors the
// cold-ingest-extraction / canonicalization-trigger queue-constants pattern (one
// source of truth for BullModule.registerQueue, the @Processor decorator, and
// getQueueToken callers).
//
// The reconcile poll is the L2→L3 ENRICH seam: a BullMQ tick drains PROMOTED
// subjects (carrying an ATS_TALENT_RECORD ref) whose immutable EvidenceRecord
// history has grown since the reconcile watermark, and projects the newer
// declared evidence into the live TalentRecord (fill-null contact + append
// key_skills). "current = projection over retained history" — L2 is the history,
// L3 the current; NO L3 version/event/log table (OPEN-2 ruling).
export const TALENT_RECONCILE_QUEUE_NAME = 'talent-reconcile' as const;

// Batch size per tick — bounded so a backlog burst doesn't hold the worker.
export const TALENT_RECONCILE_BATCH_SIZE = 100 as const;

// Transient-retry bound — a subject whose reconcile fails transiently is retried
// on later ticks; after MAX_ATTEMPTS it drops out of the poll
// (findSubjectsNeedingReconcile filters reconcile_attempts < cap).
export const TALENT_RECONCILE_MAX_ATTEMPTS = 5 as const;

// link_source-style provenance actor for reconcile-written rows (not persisted
// as an actor id here — reconcile writes evidence-ref provenance, not consent).
export const TALENT_RECONCILE_ACTOR = 'system:talent-reconcile' as const;
