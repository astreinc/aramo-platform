// M5 PR-11 §4.4 — cross-schema-consistency queue name. Architecture v2.1
// §9.2 vocabulary ("cross-schema consistency check job"; doc/01 §13:452
// anchor).
//
// Typed constant so BullModule.registerQueue, the @Processor decorator,
// and getQueueToken() callers all share one source of truth.
export const CROSS_SCHEMA_CONSISTENCY_QUEUE_NAME = 'cross-schema-consistency' as const;
