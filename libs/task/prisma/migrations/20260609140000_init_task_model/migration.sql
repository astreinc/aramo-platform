-- Tasks backend — initial migration for the `task` PG schema namespace.
-- Additive: CREATE SCHEMA + CREATE TYPE + CREATE TABLE only. Core untouched.
-- migrations 52 → 53.
--
-- The recruiter to-do (the last core recruiter surface). Polymorphic
-- owner_type/owner_id link (4 targets: talent_record/requisition/company/
-- contact) — UUID-only, NO FK (§7.3). assignee_id + created_by_user_id +
-- owner_id are logical refs validated/visibility-gated at the app layer.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "task";

-- CreateEnum
CREATE TYPE "task"."TaskStatus" AS ENUM ('open', 'done');

-- CreateTable
CREATE TABLE "task"."Task" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "due_date" TIMESTAMPTZ,
    "status" "task"."TaskStatus" NOT NULL DEFAULT 'open',
    "assignee_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "owner_type" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — my-tasks / upcoming (assignee + due-date sort).
CREATE INDEX "Task_tenant_id_assignee_id_due_date_idx"
    ON "task"."Task"("tenant_id", "assignee_id", "due_date");

-- CreateIndex — by-entity lookup (tasks on an owner).
CREATE INDEX "Task_tenant_id_owner_type_owner_id_idx"
    ON "task"."Task"("tenant_id", "owner_type", "owner_id");
