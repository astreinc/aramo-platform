-- SKILL-TAX-1B skill_alias_version. Governed alias -> canonical mapping plus
-- versions of a canonical Skill. Additive and platform-global, UUID-only refs
-- with no FK. Splitter-safe: no inline comment carries a semicolon.

-- CreateTable
CREATE TABLE "skills_taxonomy"."SkillAlias" (
    "id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "alias" TEXT NOT NULL,
    "normalized_alias" TEXT NOT NULL,
    "alias_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "SkillAlias_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SkillAlias_alias_type_check" CHECK ("alias_type" IN ('ABBREVIATION', 'COMMON_NAME', 'LEGACY_NAME', 'VENDOR_VARIANT', 'SPELLING_VARIANT')),
    CONSTRAINT "SkillAlias_status_check" CHECK ("status" IN ('active', 'inactive'))
);

-- CreateTable
CREATE TABLE "skills_taxonomy"."SkillVersion" (
    "id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "normalized_version" TEXT NOT NULL,
    "version_family" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "SkillVersion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SkillVersion_status_check" CHECK ("status" IN ('active', 'inactive'))
);

-- CreateIndex
CREATE UNIQUE INDEX "SkillAlias_normalized_alias_key" ON "skills_taxonomy"."SkillAlias"("normalized_alias");

-- CreateIndex
CREATE INDEX "SkillAlias_skill_id_idx" ON "skills_taxonomy"."SkillAlias"("skill_id");

-- CreateIndex
CREATE INDEX "SkillAlias_status_idx" ON "skills_taxonomy"."SkillAlias"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SkillVersion_skill_id_normalized_version_key" ON "skills_taxonomy"."SkillVersion"("skill_id", "normalized_version");

-- CreateIndex
CREATE INDEX "SkillVersion_skill_id_idx" ON "skills_taxonomy"."SkillVersion"("skill_id");
