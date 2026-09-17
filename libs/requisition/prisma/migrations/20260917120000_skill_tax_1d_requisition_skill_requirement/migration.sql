-- SKILL-TAX-1D requisition_skill_requirement. The typed canonical seam derived
-- from authored GoldenProfile skills. Additive table only -- NO SQL
-- canonicalization backfill (a requisition-side re-runnable worker populates and
-- reconciles the rows). No cross-schema FK: canonical_skill_id / canonical_version_id
-- reference the platform-global skills_taxonomy Skill / SkillVersion by UUID.
-- Governed status/method vocab via CHECK, matching the skills-taxonomy engine.
-- Splitter-safe: no inline comment carries a semicolon.

-- CreateTable
CREATE TABLE "requisition"."RequisitionSkillRequirement" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "golden_profile_id" UUID NOT NULL,
    "requirement_type" TEXT NOT NULL,
    "raw_surface_form" TEXT NOT NULL,
    "version_requirement" TEXT,
    "canonical_skill_id" UUID,
    "canonical_version_id" UUID,
    "canonicalization_status" TEXT,
    "canonicalization_method" TEXT,
    "canonicalized_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequisitionSkillRequirement_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RequisitionSkillRequirement_requirement_type_check" CHECK ("requirement_type" IN ('required', 'preferred', 'critical')),
    CONSTRAINT "RequisitionSkillRequirement_canonicalization_status_check" CHECK ("canonicalization_status" IN ('RESOLVED', 'UNRESOLVED', 'AMBIGUOUS', 'PROVISIONAL', 'REJECTED')),
    CONSTRAINT "RequisitionSkillRequirement_canonicalization_method_check" CHECK ("canonicalization_method" IN ('EXACT_CANONICAL', 'NORMALIZED_CANONICAL', 'ALIAS', 'VERSION', 'MANUAL', 'PROVISIONAL'))
);

-- CreateIndex
CREATE UNIQUE INDEX "RequisitionSkillRequirement_profile_type_surface_key" ON "requisition"."RequisitionSkillRequirement"("tenant_id", "golden_profile_id", "requirement_type", "raw_surface_form");

-- CreateIndex
CREATE INDEX "RequisitionSkillRequirement_tenant_requisition_idx" ON "requisition"."RequisitionSkillRequirement"("tenant_id", "requisition_id");

-- CreateIndex
CREATE INDEX "RequisitionSkillRequirement_tenant_canonical_skill_idx" ON "requisition"."RequisitionSkillRequirement"("tenant_id", "canonical_skill_id");
