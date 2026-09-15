-- SKILL-TAX-1A init_skill_registry. Canonical Skill registry (platform-global,
-- no tenant_id) + append-only SkillAuditEvent. Splitter-safe: no inline comment
-- carries a semicolon (splitDdl is comment-blind). Cross-schema refs are
-- UUID-only, no FK (Architecture 7.3).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "skills_taxonomy";

-- CreateTable
CREATE TABLE "skills_taxonomy"."Skill" (
    "id" UUID NOT NULL,
    "canonical_name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Skill_status_check" CHECK ("status" IN ('active', 'inactive'))
);

-- CreateTable
CREATE TABLE "skills_taxonomy"."SkillAuditEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "actor_id" UUID,
    "actor_type" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "event_payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SkillAuditEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SkillAuditEvent_event_type_check" CHECK ("event_type" IN ('SKILL_CREATED', 'SKILL_UPDATED', 'SKILL_DEACTIVATED', 'SKILL_MERGED', 'ALIAS_ADDED', 'ALIAS_REMOVED', 'VERSION_ADDED', 'VERSION_UPDATED', 'RELATIONSHIP_ADDED', 'RELATIONSHIP_REMOVED', 'CANONICALIZATION_OVERRIDDEN'))
);

-- CreateIndex
CREATE UNIQUE INDEX "Skill_canonical_name_key" ON "skills_taxonomy"."Skill"("canonical_name");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_normalized_name_key" ON "skills_taxonomy"."Skill"("normalized_name");

-- CreateIndex
CREATE INDEX "Skill_status_idx" ON "skills_taxonomy"."Skill"("status");

-- CreateIndex
CREATE INDEX "SkillAuditEvent_subject_id_created_at_id_idx" ON "skills_taxonomy"."SkillAuditEvent"("subject_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "SkillAuditEvent_created_at_id_idx" ON "skills_taxonomy"."SkillAuditEvent"("created_at" DESC, "id" DESC);
