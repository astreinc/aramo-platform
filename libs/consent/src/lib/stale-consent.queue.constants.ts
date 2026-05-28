// M5 PR-11 §4.2 — stale-consent queue name. Architecture v2.1 §9.2 vocabulary
// ("stale consent daily job"; doc/01 §13:450 anchor).
//
// Typed constant so BullModule.registerQueue, the @Processor decorator,
// and getQueueToken() callers all share one source of truth.
export const STALE_CONSENT_QUEUE_NAME = 'stale-consent' as const;
