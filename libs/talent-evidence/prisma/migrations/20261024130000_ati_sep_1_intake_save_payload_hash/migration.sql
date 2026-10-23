-- ATI-SEP-1 A2 follow-up (D6) — recruiter edits are never silently lost by a
-- resumed Save. Additive, ADD-not-rename: no column is renamed or dropped.
--
-- TalentIntakeDraft.save_evidence_payload_hash: the SHA-256 of the reviewed
-- evidence arrays (work_history, skills, education, certifications) that the
-- Save's step 1 materialized, stamped in the SAME talent_evidence transaction as
-- save_evidence_materialized_at. A re-Save whose TalentRecord does not exist yet
-- compares it with the current review payload and re-materializes on a
-- mismatch. NULL on drafts materialized before this column existed (treated as
-- "unknown" → re-materialized once).
ALTER TABLE "talent_evidence"."TalentIntakeDraft"
  ADD COLUMN "save_evidence_payload_hash" TEXT;
