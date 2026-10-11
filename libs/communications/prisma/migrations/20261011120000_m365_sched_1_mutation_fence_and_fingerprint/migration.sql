-- COMM-C2B Amendment A1 (M365-SCHED-1) — PR#918 final correctness pass. Additive,
-- non-destructive. Adds the mutation-ownership fence and the full idempotency-identity
-- binding required for safe concurrency + recovery.

-- 1) Exclusive mutation fence (FIX-1). A reschedule/cancel reservation ACQUIRES this
--    lock and holds it until finalize (success) or reconcile (recovery) releases it.
--    A second reservation on the same meeting is refused while the lock is held — even
--    at the post-reservation version — so two mutations can never reach Graph at once.
ALTER TABLE "communications"."CommunicationInteraction"
  ADD COLUMN "mutation_locked_at" TIMESTAMPTZ;

-- 2) Full request-identity binding (FIX-3). The idempotency key is bound to the
--    IMMUTABLE scheduling request (organizer, Talent, Requisition, subject, start/end,
--    timezone, effective connection). Reuse with any changed field is rejected, never
--    a stale successful-operation replay.
ALTER TABLE "communications"."MeetingSchedulingOperation"
  ADD COLUMN "request_fingerprint" TEXT;
