-- PR-A4 Gate 5 — initial migration for the `attachment` PG schema namespace.
-- Additive: CREATE SCHEMA + CREATE TYPE + CREATE TABLE only. Core untouched.
--
-- New PG schema: `attachment` — twentieth namespace in the workspace.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "attachment";

-- CreateEnum (typed discriminator — directive §4. All 4 values defined
-- now; A4 wires + tests the `talent` path only.)
CREATE TYPE "attachment"."AttachmentOwnerType" AS ENUM ('talent', 'requisition', 'company', 'contact');

-- CreateTable
CREATE TABLE "attachment"."Attachment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "site_id" UUID,
    "owner_type" "attachment"."AttachmentOwnerType" NOT NULL,
    "owner_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "is_resume" BOOLEAN NOT NULL DEFAULT false,
    "uploaded_by_id" UUID,
    "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Attachment_tenant_id_owner_type_owner_id_idx" ON "attachment"."Attachment"("tenant_id", "owner_type", "owner_id");

-- CreateIndex
CREATE INDEX "Attachment_tenant_id_site_id_idx" ON "attachment"."Attachment"("tenant_id", "site_id");
