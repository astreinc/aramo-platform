// T2-3 — canonicalization trigger queue constants. Mirrors the
// OUTBOX_PUBLISHER + MATCH queue-constants pattern (one source of truth
// shared by BullModule.registerQueue, the @Processor decorator, and
// getQueueToken() callers).
//
// The trigger queue is the ingestion → canonicalization production seam:
// a BullMQ repeat job ticks the CanonicalizationTriggerProcessor which
// drains unresolved RawPayloadReference rows (the polling-outbox shape —
// the row's resolved_talent_id IS NULL IS the work-to-do signal; no
// separate outbox table needed).
//
// Why the polling-outbox shape (Lead-reviewable design choice):
//   - Durability: a failed canonicalize leaves resolved_talent_id NULL;
//     the next tick re-picks. A payload is NEVER lost on failure.
//   - Idempotency: two layers — (a) the polling query filters out
//     already-resolved rows (WHERE resolved_talent_id IS NULL);
//     (b) canonicalize's resolved_talent_id short-circuit (T2-2a Step
//     2) catches any race-induced re-fire.
//   - Atomicity: createPayload's commit IS the trigger commit (the
//     RawPayloadReference row appearing IS the trigger). No separate
//     ingestion.OutboxEvent write needed → no schema/migration.
//   - No cycle: canonicalization already imports ingestion (T2-2a
//     follower); the trigger processor lives IN canonicalization. No
//     reverse ingestion → canonicalization edge.
export const CANONICALIZATION_TRIGGER_QUEUE_NAME =
  'canonicalization-trigger' as const;

// Batch size per trigger tick — bounded so a backlog burst doesn't
// hold the worker indefinitely. 100 mirrors OUTBOX_PUBLISHER_BATCH_SIZE
// (Ruling 2 precedent).
export const CANONICALIZATION_TRIGGER_BATCH_SIZE = 100 as const;
