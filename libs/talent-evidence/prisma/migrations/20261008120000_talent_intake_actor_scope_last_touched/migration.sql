-- Talent Draft Recovery UX/IA (§22) — additive, ADD-not-rename.
-- Adds the authoritative recruiter-touch instant used by the My Desk 3-day
-- staleness rule. No column is renamed or dropped and existing rows keep values.
--
-- Touch semantics (enforced in application code, TalentEvidenceRepository):
--   set on creation and bumped ONLY by recruiter-sourced actions (review PATCH,
--   retry, resume replace). NEVER bumped by background extraction (updated_at)
--   nor by an open (last_opened_at). Actor-private draft ownership (created_by)
--   is enforced in the query WHERE clauses, not by schema.

ALTER TABLE "talent_evidence"."TalentIntakeDraft"
  ADD COLUMN "last_touched_at" TIMESTAMPTZ;

-- Backfill a sane staleness baseline for pre-existing drafts: treat creation as
-- the first touch so the My Desk rule has a defined instant for every row.
UPDATE "talent_evidence"."TalentIntakeDraft"
  SET "last_touched_at" = "created_at"
  WHERE "last_touched_at" IS NULL;

-- Staleness-scan index for the actor-scoped My Desk projection.
CREATE INDEX "TalentIntakeDraft_tenant_creator_touched_idx"
  ON "talent_evidence"."TalentIntakeDraft" ("tenant_id", "created_by", "last_touched_at");
