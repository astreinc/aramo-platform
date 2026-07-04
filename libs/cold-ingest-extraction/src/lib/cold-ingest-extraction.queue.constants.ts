// Cold-Ingest Extraction — trigger queue constants. Mirrors the
// canonicalization-trigger queue-constants pattern (one source of truth
// shared by BullModule.registerQueue, the @Processor decorator, and
// getQueueToken() callers).
//
// The trigger queue is the resolved-arrival → declared-evidence extraction
// seam: a BullMQ repeat job ticks the ColdIngestExtractionProcessor which
// drains RESOLVED RawPayloadReference rows whose résumé still needs
// extraction. This mirrors the canonicalize poll's substrate-aligned shape —
// the row's own state IS the work-to-do signal; no separate outbox table:
//
//   - needs-extraction = resolved_subject_id IS NOT NULL (canonicalized)
//     AND extraction_done_at IS NULL (not yet extracted) AND
//     extraction_attempts < cap (under the transient-retry bound).
//   - Durability: a transient (S3/fetch) failure bumps extraction_attempts
//     and leaves extraction_done_at NULL; the next tick re-picks the row
//     until the cap. A parse with no name stamps extraction_done_at (a
//     name-less résumé must NOT loop).
//   - No cycle: cold-ingest-extraction imports ingestion (poll + marker),
//     resume-parse (parse), and talent-trust (evidence write) — all
//     scope:cip. No reverse edge; lint:nx-boundaries stays green.
export const COLD_INGEST_EXTRACTION_QUEUE_NAME =
  'cold-ingest-extraction' as const;

// Batch size per trigger tick — bounded so a backlog burst doesn't hold the
// worker indefinitely. 100 mirrors CANONICALIZATION_TRIGGER_BATCH_SIZE.
export const COLD_INGEST_EXTRACTION_BATCH_SIZE = 100 as const;

// Transient-retry bound. A résumé fetch that fails transiently (S3 presign /
// network) is retried on later ticks; after MAX_ATTEMPTS the row drops out of
// the poll (findArrivalsNeedingExtraction filters extraction_attempts < cap)
// so a persistently-unreachable object does not spin forever.
export const COLD_INGEST_EXTRACTION_MAX_ATTEMPTS = 5 as const;

// System actor recorded on the declared EvidenceRecords + events this poll
// writes (created_by / actor). Non-human origin — the extraction is an
// automated deterministic parse, never a user action.
export const COLD_INGEST_EXTRACTION_ACTOR =
  'system:cold-ingest-extraction' as const;
