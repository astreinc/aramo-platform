// Promotion Gate Slice-B2 — contradiction-detection poll queue constants. A
// second subject-poll in libs/talent-reconcile, sibling to the B1 reconcile
// poll (one source of truth for BullModule.registerQueue + @Processor +
// getQueueToken).
//
// The poll drains B1's PendingContradictionRow store (status='pending'): for
// each, it joins to the incumbent EvidenceRecord the field projects and raises
// the L2 contradiction — contradict(incumbent, byB=new) → EvidenceLink
// CONTRADICTS + CONTRADICTED lifecycle + open_contradiction_count↑ + band cap.
// The status pending→resolved flip is the MANDATORY idempotency gate
// (contradict() is not link-idempotent); a resolved row is never re-polled.
export const CONTRADICTION_DETECTION_QUEUE_NAME =
  'contradiction-detection' as const;

// Batch size per tick — bounded so a backlog burst doesn't hold the worker.
export const CONTRADICTION_DETECTION_BATCH_SIZE = 100 as const;
