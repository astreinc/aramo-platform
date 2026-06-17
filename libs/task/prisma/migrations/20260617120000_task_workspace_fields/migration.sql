-- Task Workspace Fields amendment (v1.0 LOCKED) — additive only. Core untouched.
--
-- Expands the Task lifecycle and adds the three plain-String closed-set
-- workspace columns (type / priority / source) that the Tasks-page mockup's
-- visual language depends on. NO data loss: the two existing enum values
-- (open, done) are preserved; the three new values are appended.
--
-- Representation: type/priority/source are TEXT + an app-layer closed-set guard
-- (no new Prisma enum). status remains the existing enum, expanded in place.

-- AlterEnum — append the three new lifecycle values (existing open/done kept).
-- ACTIVE = open/in_progress/waiting; TERMINAL = done/cancelled. PostgreSQL 12+
-- (CI uses postgres:17) permits ADD VALUE; the new values are not referenced by
-- any DDL in this migration, so no in-transaction-use hazard.
ALTER TYPE "task"."TaskStatus" ADD VALUE IF NOT EXISTS 'in_progress';
ALTER TYPE "task"."TaskStatus" ADD VALUE IF NOT EXISTS 'waiting';
ALTER TYPE "task"."TaskStatus" ADD VALUE IF NOT EXISTS 'cancelled';

-- AlterTable — the three workspace columns. type/priority nullable; source
-- NOT NULL default 'manual'. Existing rows backfill to source='manual'.
ALTER TABLE "task"."Task" ADD COLUMN "type" TEXT;
ALTER TABLE "task"."Task" ADD COLUMN "priority" TEXT;
ALTER TABLE "task"."Task" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';

-- CreateIndex — btree on the filtered closed-set columns (amendment §5).
CREATE INDEX "Task_tenant_id_status_idx" ON "task"."Task"("tenant_id", "status");
CREATE INDEX "Task_tenant_id_type_idx" ON "task"."Task"("tenant_id", "type");
CREATE INDEX "Task_tenant_id_priority_idx" ON "task"."Task"("tenant_id", "priority");
