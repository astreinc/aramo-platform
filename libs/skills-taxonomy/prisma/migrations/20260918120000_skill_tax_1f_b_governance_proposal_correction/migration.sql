-- SKILL-TAX-1F-B — governance proposal + durable correction work-record tables.
--
-- SkillGovernanceProposal: the AI proposal-only substrate. An AI_RECOMMENDED
-- suggestion is never canonical truth until a human platform:skill:manage actor
-- accepts it. Governed vocab via CHECK. No FK (UUID-only refs).
--
-- SkillCorrectionTask: the DURABLE post-commit propagation work-record. Created in
-- the same transaction as a governance mutation so a committed merge always leaves
-- a durable record of the repoint/reconcile it owes. A processor drains it
-- idempotently and retries failures. Both tables are split-safe (no dollar-quoted
-- bodies, no inline separators in comments).

-- CreateTable
CREATE TABLE "skills_taxonomy"."SkillGovernanceProposal" (
    "id" UUID NOT NULL,
    "proposal_type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "proposed_by" UUID,
    "proposed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ,
    "decision_reason" TEXT,
    "applied_entity_id" UUID,

    CONSTRAINT "SkillGovernanceProposal_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SkillGovernanceProposal_proposal_type_check" CHECK ("proposal_type" IN ('ALIAS', 'RELATIONSHIP')),
    CONSTRAINT "SkillGovernanceProposal_source_check" CHECK ("source" IN ('AI_RECOMMENDED')),
    CONSTRAINT "SkillGovernanceProposal_status_check" CHECK ("status" IN ('PENDING', 'ACCEPTED', 'REJECTED'))
);

-- CreateIndex
CREATE INDEX "SkillGovernanceProposal_status_proposed_at_idx" ON "skills_taxonomy"."SkillGovernanceProposal"("status", "proposed_at");

-- CreateTable
CREATE TABLE "skills_taxonomy"."SkillCorrectionTask" (
    "id" UUID NOT NULL,
    "correction_type" TEXT NOT NULL,
    "from_canonical_skill_id" UUID,
    "to_canonical_skill_id" UUID,
    "surface_form" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "SkillCorrectionTask_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SkillCorrectionTask_correction_type_check" CHECK ("correction_type" IN ('SKILL_MERGE', 'ALIAS_CORRECTION', 'OVERRIDE_CORRECTION')),
    CONSTRAINT "SkillCorrectionTask_status_check" CHECK ("status" IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED'))
);

-- CreateIndex
CREATE INDEX "SkillCorrectionTask_status_created_at_idx" ON "skills_taxonomy"."SkillCorrectionTask"("status", "created_at");
