-- SKILL-TAX-1G canonical reconciliation. Additive NULLABLE canonical columns on
-- TalentSkillEvidence + an additive canonical supported-years projection on
-- TalentDerivedSnapshot. Columns only -- NO SQL canonicalization backfill (the
-- application-level worker resolves existing rows). No cross-schema FK. Governed
-- status/method vocab via CHECK, matching the skills-taxonomy engine unions.
-- Splitter-safe: no inline comment carries a semicolon.

-- AlterTable
ALTER TABLE "talent_evidence"."TalentSkillEvidence"
    ADD COLUMN "canonical_skill_id" UUID,
    ADD COLUMN "canonical_version_id" UUID,
    ADD COLUMN "canonicalization_status" TEXT,
    ADD COLUMN "canonicalization_method" TEXT,
    ADD COLUMN "canonicalized_at" TIMESTAMPTZ;

-- CHECK: canonicalization_status vocabulary (NULL allowed = not yet reconciled)
ALTER TABLE "talent_evidence"."TalentSkillEvidence"
    ADD CONSTRAINT "TalentSkillEvidence_canonicalization_status_check"
    CHECK ("canonicalization_status" IN ('RESOLVED', 'UNRESOLVED', 'AMBIGUOUS', 'PROVISIONAL', 'REJECTED'));

-- CHECK: canonicalization_method vocabulary (NULL allowed = unresolved or not yet reconciled)
ALTER TABLE "talent_evidence"."TalentSkillEvidence"
    ADD CONSTRAINT "TalentSkillEvidence_canonicalization_method_check"
    CHECK ("canonicalization_method" IN ('EXACT_CANONICAL', 'NORMALIZED_CANONICAL', 'ALIAS', 'VERSION', 'MANUAL', 'PROVISIONAL'));

-- CreateIndex
CREATE INDEX "TalentSkillEvidence_tenant_talent_canonical_skill_idx"
    ON "talent_evidence"."TalentSkillEvidence"("tenant_id", "talent_id", "canonical_skill_id");

-- AlterTable
ALTER TABLE "talent_evidence"."TalentDerivedSnapshot"
    ADD COLUMN "estimated_years_experience_by_canonical_skill" JSONB;
