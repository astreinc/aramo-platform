-- ATI-SEP-1 A2 — TalentWorkHistoryEntry.assertions: the role's reviewed
-- experience assertions persisted as ATS evidence of record. Additive, nullable
-- (ADD-not-rename), rows written before A2 keep NULL. Kept in its own migration
-- (independent of TalentIntakeDraft) so partial integration migration sets that
-- carry only the work-history table can apply it.
ALTER TABLE "talent_evidence"."TalentWorkHistoryEntry"
  ADD COLUMN "assertions" JSONB;
