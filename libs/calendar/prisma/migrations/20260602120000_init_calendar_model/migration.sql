-- PR-A6 Gate 5+6 (combined) — initial migration for the `calendar` PG schema.
-- Additive at the DB level: CREATE SCHEMA + CREATE TYPE + CREATE TABLE only.
-- Nothing in any existing namespace is altered (Core-untouched).
--
-- New PG schema: `calendar` — one of two new namespaces in PR-A6 (the
-- other is `saved_list`).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "calendar";

-- CreateEnum
CREATE TYPE "calendar"."CalendarEventType" AS ENUM ('call', 'email', 'meeting', 'interview', 'personal', 'other');

-- CreateTable
CREATE TABLE "calendar"."CalendarEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "site_id" UUID,
    "owner_id" UUID NOT NULL,
    "type" "calendar"."CalendarEventType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ,
    "all_day" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CalendarEvent_tenant_id_owner_id_idx" ON "calendar"."CalendarEvent"("tenant_id", "owner_id");

-- CreateIndex
CREATE INDEX "CalendarEvent_tenant_id_starts_at_idx" ON "calendar"."CalendarEvent"("tenant_id", "starts_at");

-- CreateIndex
CREATE INDEX "CalendarEvent_tenant_id_site_id_idx" ON "calendar"."CalendarEvent"("tenant_id", "site_id");
