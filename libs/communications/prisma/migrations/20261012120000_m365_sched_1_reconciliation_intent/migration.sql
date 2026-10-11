-- COMM-C2B Amendment A1 (M365-SCHED-1) — PR#918 reconciliation pass. Additive,
-- non-destructive. Persists the DURABLE intent of a fenced reschedule/cancel so
-- reconciliation can verify the provider's ACTUAL state against what was intended.

-- Durable mutation intent, stamped atomically with the fence and cleared on finalize
-- or reconcile. `pending_mutation` is 'reschedule' or 'cancel'. For a reschedule,
-- `pending_start`/`pending_end` are the intended window the provider event MUST match
-- before the outcome is accepted as rescheduled. Without this a fenced row still holds
-- the OLD window, so a reconcile could not distinguish "the reschedule landed" from
-- "the provider is unchanged". All nullable — non-scheduling and non-fenced rows none.
ALTER TABLE "communications"."CommunicationInteraction"
  ADD COLUMN "pending_mutation" TEXT,
  ADD COLUMN "pending_start" TIMESTAMPTZ,
  ADD COLUMN "pending_end" TIMESTAMPTZ;
