-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "evidence";

-- CreateTable
CREATE TABLE "evidence"."TalentJobEvidencePackage" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "talent_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "examination_id" UUID NOT NULL,
    "submittal_record_id" UUID,
    "parent_package_id" UUID,
    "talent_identity" JSONB NOT NULL,
    "contact_summary" JSONB NOT NULL,
    "capability_summary" JSONB NOT NULL,
    "match_justification" JSONB NOT NULL,
    "recruiter_contribution" JSONB NOT NULL,
    "engagement_event_refs" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TalentJobEvidencePackage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TalentJobEvidencePackage_tenant_id_talent_id_job_id_idx" ON "evidence"."TalentJobEvidencePackage"("tenant_id", "talent_id", "job_id");

-- CreateIndex
CREATE INDEX "TalentJobEvidencePackage_tenant_id_submittal_record_id_idx" ON "evidence"."TalentJobEvidencePackage"("tenant_id", "submittal_record_id");

-- CreateIndex
CREATE INDEX "TalentJobEvidencePackage_tenant_id_examination_id_idx" ON "evidence"."TalentJobEvidencePackage"("tenant_id", "examination_id");

-- CreateIndex
CREATE INDEX "TalentJobEvidencePackage_tenant_id_parent_package_id_idx" ON "evidence"."TalentJobEvidencePackage"("tenant_id", "parent_package_id");

-- ============================================================================
-- TalentJobEvidencePackage immutability — M4 PR-1 directive §4.2.
-- Per Group 2 §2.6 "Immutable after submittal confirmation". The spec
-- entity has no lifecycle column (no updated_at, no status), so the
-- trigger is whole-row unconditional — any UPDATE is rejected.
-- Mechanism precedent: consent TalentConsentEvent (PR-2, whole-row).
-- Belt-and-suspenders: the EvidenceRepository surface exposes no
-- write methods at PR-1 (libs/evidence/src/lib/evidence.repository.ts).
-- NOTE: keep this comment block free of literal semicolons and free of
-- the dollar-quote delimiter sequence. The integration test setup
-- applies the migration via a dollar-quote-aware splitter that splits
-- on the statement terminator outside dollar-quoted regions but does
-- not strip line comments, so either token inside a comment confuses it.
-- ============================================================================
CREATE OR REPLACE FUNCTION evidence.reject_evidence_package_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'TalentJobEvidencePackage is immutable per Group 2 §2.6; UPDATE not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_evidence_package_update
  BEFORE UPDATE ON evidence."TalentJobEvidencePackage"
  FOR EACH ROW EXECUTE FUNCTION evidence.reject_evidence_package_update();
