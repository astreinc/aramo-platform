// M5 PR-11 §4.3 — outbox-publisher queue name. Architecture v2.1 §9.2
// vocabulary ("outbox publisher job"; doc/01 §13:451 anchor).
//
// Typed constant so BullModule.registerQueue, the @Processor decorator,
// and getQueueToken() callers all share one source of truth.
export const OUTBOX_PUBLISHER_QUEUE_NAME = 'outbox-publisher' as const;

// PR-11 §4.3 — batch size per publisher tick. Per Ruling 2: "Batch size:
// 100 events per tick. Tick interval: 30 seconds (BullMQ repeat job)."
export const OUTBOX_PUBLISHER_BATCH_SIZE = 100 as const;
