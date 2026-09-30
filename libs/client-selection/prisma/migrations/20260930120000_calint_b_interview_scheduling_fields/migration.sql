-- Calendar/Interview Slice B — additive scheduling fields on InterviewSession.
-- ADD-not-rename. Both columns are nullable and backward-compatible with every legacy row.
-- scheduled_at stays the authoritative START instant. scheduled_end_at is the
-- authoritative END instant (nullable, and NEVER fabricated for legacy rows). timezone is
-- an IANA display/input zone (nullable). The scheduled_end_at greater-than scheduled_at
-- rule is enforced at the application write boundary, not by a DB constraint, because
-- legacy rows carry neither value.
ALTER TABLE "client_selection"."InterviewSession"
  ADD COLUMN "scheduled_end_at" TIMESTAMPTZ,
  ADD COLUMN "timezone" TEXT;
