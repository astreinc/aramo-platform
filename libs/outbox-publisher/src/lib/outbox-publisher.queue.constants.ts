// M6 PR-2 §4 — outbox-publisher queue constants. Relocated from
// libs/consent (M5 PR-11) to the new leaf lib libs/outbox-publisher so
// the publisher can drain consent + engagement + submittal outbox tables
// without creating a consent → engagement|submittal import cycle
// (lint-nx-boundaries / import-x/no-cycle enforcement).
//
// Architecture v2.1 §9.2 vocabulary ("outbox publisher job"; doc/01 §13:451
// anchor). Typed constant so BullModule.registerQueue, the @Processor
// decorator, and getQueueToken() callers all share one source of truth.
export const OUTBOX_PUBLISHER_QUEUE_NAME = 'outbox-publisher' as const;

// PR-11 §4.3 — batch size per publisher tick. Per Ruling 2: "Batch size:
// 100 events per tick. Tick interval: 30 seconds (BullMQ repeat job)."
// Unchanged at M6 PR-2 — the publisher now drains three schemas per tick
// with the same per-schema batch cap; engagement + submittal each get
// their own batch of up to 100 events alongside the consent batch.
export const OUTBOX_PUBLISHER_BATCH_SIZE = 100 as const;
