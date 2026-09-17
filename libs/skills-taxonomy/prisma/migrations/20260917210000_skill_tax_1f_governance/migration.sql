-- SKILL-TAX-1F — Skill.merged_into_skill_id (the soft-merge pointer).
--
-- A merged (loser) Skill keeps its id (permanently addressable for audit and
-- history), sets status inactive, and points at the winner. UUID-only, NO FK
-- (Architecture Section 7.3). NULL for every non-merged Skill. ADD-not-rename.
--
-- Split-safe: no dollar-quoted body and no inline statement separators in the
-- comments, so an integration spec that provisions the skills_taxonomy schema with
-- a naive comma-free line splitter can apply this column migration. The append-only
-- SkillAuditEvent trigger lives in a SEPARATE migration (20260917211000).

-- AlterTable
ALTER TABLE "skills_taxonomy"."Skill" ADD COLUMN "merged_into_skill_id" UUID;

-- CreateIndex
CREATE INDEX "Skill_merged_into_skill_id_idx" ON "skills_taxonomy"."Skill"("merged_into_skill_id");
