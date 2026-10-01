-- Calendar/Interview Slice C — additive provider-neutral meeting association on
-- InterviewSession. ADD-not-rename, nullable, backward-compatible with every legacy row.
-- meeting_interaction_id is a UUID-ref to communications.CommunicationInteraction
-- (channel='meeting') with no FK. The canonical meeting evidence stays in Communications.
-- The session NEVER stores a provider url, meeting id, or mailbox.
ALTER TABLE "client_selection"."InterviewSession"
  ADD COLUMN "meeting_interaction_id" UUID;
