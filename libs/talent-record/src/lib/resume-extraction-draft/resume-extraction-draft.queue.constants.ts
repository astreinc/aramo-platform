// TALENT-INTEL-1 (TI-1F-A) — the résumé-extraction-draft worker queue constants.
// Mirrors the RESUME_REINDEX / CANONICALIZATION_TRIGGER queue-constants pattern
// (one source of truth shared by BullModule.registerQueue, the @Processor
// decorator, and the registration.ts getQueueToken caller).
//
// Polling-outbox shape: a PROCESSING ResumeExtractionDraft row IS the work-to-do
// signal (written synchronously at the existing-Talent add-résumé-edition seam).
// The repeat-tick worker drains PROCESSING drafts — one governed
// ResumeExtractionOrchestrator ATTACHMENT extraction per draft → READY_FOR_REVIEW
// or FAILED. NO typed evidence (that is TI-1F-B). Redis-gated: inert in CI /
// Redis-less envs (the proofs call the drain directly).
//
// The CREATE_DRAFT_UPLOAD flow does NOT use this worker in A — that draft is
// persisted synchronously (READY_FOR_REVIEW) at the draft-from-resume seam from
// the same in-request governed result. This CREATE-sync / EXISTING-async
// asymmetry is INTENTIONAL + TRANSITIONAL for A (removed in TI-1F-C when the
// create flow also goes async).
export const RESUME_EXTRACTION_DRAFT_QUEUE_NAME = 'resume-extraction-draft' as const;

// Batch size per tick — bounded so a backlog burst does not hold the worker
// indefinitely.
export const RESUME_EXTRACTION_DRAFT_BATCH_SIZE = 25 as const;
