-- CRM-1 — SavedList visibility + purpose (directive §5.2 / §5.3).
-- Additive only: CREATE TYPE + ADD COLUMN + one backfill UPDATE. Nothing in any
-- existing namespace is altered, and no column is renamed (ADD-not-rename).
--
-- visibility defaults to 'private' (least-visibility). The reserved per-tenant
-- sourcing bench (list_kind = 'tenant_bench') is a shared list, so it is
-- backfilled to 'tenant'. purpose is a nullable free-text label.

-- CreateEnum
CREATE TYPE "saved_list"."SavedListVisibility" AS ENUM ('private', 'tenant');

-- AlterTable
ALTER TABLE "saved_list"."SavedList"
    ADD COLUMN "visibility" "saved_list"."SavedListVisibility" NOT NULL DEFAULT 'private',
    ADD COLUMN "purpose" TEXT;

-- Backfill: the reserved per-tenant sourcing bench is tenant-visible (shared).
UPDATE "saved_list"."SavedList" SET "visibility" = 'tenant' WHERE "list_kind" = 'tenant_bench';
