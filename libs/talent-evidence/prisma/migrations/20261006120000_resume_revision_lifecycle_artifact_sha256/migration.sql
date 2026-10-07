-- Resume Revision Lifecycle v1.0 LOCKED — §4/§11 exact-duplicate protection
-- (D-2 PO ruling). ADDITIVE ONLY: a nullable artifact byte-SHA-256 on the
-- existing TalentResumeEdition, plus a per-Talent uniqueness guard so a re-upload
-- of identical bytes cannot create a second revision. No backfill (legacy rows
-- keep null and Postgres UNIQUE treats nulls as distinct, so they never collide).
-- The hash is the raw-object-bytes SHA-256 — NEVER the filename or extracted text.

-- AlterTable
ALTER TABLE "talent_evidence"."TalentResumeEdition" ADD COLUMN "artifact_sha256" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "TalentResumeEdition_tenant_id_talent_id_artifact_sha256_key" ON "talent_evidence"."TalentResumeEdition"("tenant_id", "talent_id", "artifact_sha256");
