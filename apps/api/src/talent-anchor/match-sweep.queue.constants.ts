// TR-6 B1 (DDR §2) — the scheduled incremental match-sweep queue constants.
// Mirrors the talent-reconcile / cold-ingest-extraction / canonicalization-trigger
// queue-constants pattern (one source of truth for BullModule.registerQueue, the
// @Processor decorator, and getQueueToken callers in the SCHEDULES registrar).
//
// The sweep is the recurring analogue of the one-shot match-backfill CLI: an
// hourly BullMQ tick drains ACTIVE subjects whose newest SubjectAnchor is newer
// than their last_matched_at watermark (a new anchor since the last same-human
// match), re-matches each, and stamps the watermark. Incremental by construction —
// an unchanged subject is not re-swept.
export const MATCH_SWEEP_QUEUE_NAME = 'match-sweep' as const;

// Subjects drained per tick — bounded (DISTINCT ON … LIMIT) so a backlog burst
// never holds the worker. The gate re-selects any subject left un-watermarked.
export const MATCH_SWEEP_BATCH_SIZE = 100 as const;
