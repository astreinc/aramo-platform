// M5 PR-11 §4.5 — skill-canonicalization queue name. Architecture v2.1
// §9.2 vocabulary ("skill canonicalization job"; doc/01 §13:453 anchor).
//
// Typed constant so BullModule.registerQueue, the @Processor decorator,
// and getQueueToken() callers all share one source of truth.
export const SKILL_CANONICALIZATION_QUEUE_NAME = 'skill-canonicalization' as const;
