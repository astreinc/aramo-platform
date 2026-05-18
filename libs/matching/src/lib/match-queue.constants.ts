// M3 PR-3 §4.4 — match queue name. Architecture v2.1 §9.2 vocabulary:
// "match queue" / "matching worker". Tier-2 forbidden vocabulary
// (legacy queue names) is not used here.
//
// Exported as a typed constant so BullModule.registerQueue, the
// @Processor decorator, and getQueueToken() callers all share one
// source of truth and renaming is a single-site change.
export const MATCH_QUEUE_NAME = 'match' as const;
