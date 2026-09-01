-- L3-D (Client Consideration) — one InterviewSession per (process, round).
-- A round is a single session that transitions through its states IN PLACE
-- (reschedule updates scheduled_at, it does not create a second row). A genuine
-- re-attempt uses the next round. This unique index makes a duplicate schedule at
-- the same round fail deterministically (translated to INTERVIEW_ROUND_EXISTS 409)
-- rather than silently creating a parallel session for the same round.
CREATE UNIQUE INDEX "InterviewSession_process_round_key"
    ON "client_selection"."InterviewSession" ("client_selection_process_id", "round");
