-- Aramo-Template-Sync-1 Directive v1.0 (LOCKED) S-1 (rulings R-3, R-8) and §0 (amends ORG-UX-1
-- §5.1 and ADR-0034 D3, narrowly). ADD-not-rename only.
--
-- (1) TemplateVersion.based_on_platform_version_id (nullable UUID, no foreign key): the PLATFORM
--     (Aramo default) version a TENANT version's content came from. Written by Adopt (the
--     version adopted), by "Start a draft from the new version" (the master version used), and
--     carried by a tenant's own new draft from its current version. Read only to tell a company
--     that a newer master version exists. Never read by resolution or rendering.
-- (2) DocumentTemplate.sync_kept_platform_version_id (nullable UUID, no foreign key): "Keep my
--     version" for that master version. The notice hides for that master version only.
-- (3) Indexes on DocumentTemplate(adopted_from_template_id) and
--     TemplateVersion(based_on_platform_version_id), for the newer-version and withdrawal reads.
-- (4) Backfill: every version of an adopted template gets based_on_platform_version_id =
--     the template's adopted_from_version_id (the content it was copied from). The
--     TemplateVersion immutability trigger freezes content columns only, so this column may
--     be written on ACTIVE and RETIRED rows.
--
-- adopted_from_template_id / adopted_from_version_id stay written-once provenance. A master
-- change still never propagates into, overwrites or invalidates an adopted copy by itself:
-- every update is a new DRAFT that the company previews and approves.
-- Idempotent: IF NOT EXISTS adds and indexes, the backfill only fills NULLs.
-- splitDdl-safe: no semicolons in comment lines.

ALTER TABLE "documents"."TemplateVersion" ADD COLUMN IF NOT EXISTS "based_on_platform_version_id" UUID;
ALTER TABLE "documents"."DocumentTemplate" ADD COLUMN IF NOT EXISTS "sync_kept_platform_version_id" UUID;

CREATE INDEX IF NOT EXISTS "DocumentTemplate_adopted_from_template_id_idx"
  ON "documents"."DocumentTemplate" ("adopted_from_template_id");
CREATE INDEX IF NOT EXISTS "TemplateVersion_based_on_platform_version_id_idx"
  ON "documents"."TemplateVersion" ("based_on_platform_version_id");

UPDATE "documents"."TemplateVersion" v
   SET "based_on_platform_version_id" = t."adopted_from_version_id"
  FROM "documents"."DocumentTemplate" t
 WHERE v."template_id" = t."id"
   AND t."owner_scope" = 'TENANT'
   AND t."adopted_from_version_id" IS NOT NULL
   AND v."based_on_platform_version_id" IS NULL;
