-- SKILL-TAX-1C skill_relationship. Governed canonical-to-canonical edges.
-- Additive and platform-global, UUID-only refs with no FK. A self-edge is
-- rejected at the DB, and duplicate edges are blocked by the unique index.
-- Splitter-safe: no inline comment carries a semicolon.

-- CreateTable
CREATE TABLE "skills_taxonomy"."SkillRelationship" (
    "id" UUID NOT NULL,
    "source_skill_id" UUID NOT NULL,
    "target_skill_id" UUID NOT NULL,
    "relationship_type" TEXT NOT NULL,
    "directionality" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "source" TEXT NOT NULL,
    "source_ref" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_by" UUID,

    CONSTRAINT "SkillRelationship_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SkillRelationship_no_self_edge_check" CHECK ("source_skill_id" <> "target_skill_id"),
    CONSTRAINT "SkillRelationship_type_check" CHECK ("relationship_type" IN ('RELATED_TO', 'COMPATIBLE_WITH', 'PARENT_OF', 'BUILT_ON', 'REQUIRES', 'SUPERSEDES')),
    CONSTRAINT "SkillRelationship_directionality_check" CHECK ("directionality" IN ('DIRECTED', 'SYMMETRIC')),
    CONSTRAINT "SkillRelationship_status_check" CHECK ("status" IN ('active', 'inactive')),
    CONSTRAINT "SkillRelationship_source_check" CHECK ("source" IN ('VENDOR_DOC', 'ADMIN_CURATED', 'IMPORTED_TAXONOMY', 'AI_RECOMMENDED'))
);

-- CreateIndex
CREATE UNIQUE INDEX "SkillRelationship_source_target_type_key" ON "skills_taxonomy"."SkillRelationship"("source_skill_id", "target_skill_id", "relationship_type");

-- CreateIndex
CREATE INDEX "SkillRelationship_source_skill_id_idx" ON "skills_taxonomy"."SkillRelationship"("source_skill_id");

-- CreateIndex
CREATE INDEX "SkillRelationship_target_skill_id_idx" ON "skills_taxonomy"."SkillRelationship"("target_skill_id");
