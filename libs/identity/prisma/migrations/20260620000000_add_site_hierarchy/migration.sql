-- Settings Rebuild Directive 4 — sites/branches hierarchy.
--
-- Additive self-referential parent link on identity.Site. The column is
-- NULLABLE: every existing site becomes a root branch (parent_site_id = NULL)
-- and keeps its exact pre-D4 semantics. No data migration, no NOT NULL, no
-- default needed.
--
-- The Site table is created by 20260601000000_add_site_axis; this migration
-- MUST be applied after it (the curated integration apply-lists that include
-- the site axis get this migration appended after the tenant-profile one).
--
-- ON DELETE SET NULL: if a parent is ever hard-deleted, its children fall back
-- to roots rather than dangling. (The CRUD delete guard already refuses to
-- hard-delete a site that still has children or member references, so this is
-- a belt-and-suspenders safety net, and it matches Prisma's default for an
-- optional self-relation.)

-- AlterTable (identity.Site: add nullable self-referential parent link)
ALTER TABLE "identity"."Site" ADD COLUMN "parent_site_id" UUID;

-- CreateIndex
CREATE INDEX "Site_parent_site_id_idx" ON "identity"."Site"("parent_site_id");

-- AddForeignKey
ALTER TABLE "identity"."Site"
    ADD CONSTRAINT "Site_parent_site_id_fkey"
    FOREIGN KEY ("parent_site_id") REFERENCES "identity"."Site"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
