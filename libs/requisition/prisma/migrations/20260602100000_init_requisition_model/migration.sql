-- PR-A3 Gate 5 — initial migration for the `requisition` PG schema namespace.
-- Additive: CREATE SCHEMA + CREATE TYPE + CREATE TABLE only. Core untouched.
--
-- New PG schema: `requisition` — eighteenth namespace in the workspace.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "requisition";

-- CreateEnum
CREATE TYPE "requisition"."RequisitionStatus" AS ENUM ('active', 'on_hold', 'full', 'closed', 'canceled', 'lead');

-- CreateTable
CREATE TABLE "requisition"."Requisition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "site_id" UUID,
    "title" TEXT NOT NULL,
    "company_id" UUID NOT NULL,
    "contact_id" UUID,
    "company_department_id" UUID,
    "status" "requisition"."RequisitionStatus" NOT NULL DEFAULT 'active',
    "type" TEXT,
    "duration" TEXT,
    "rate_max" TEXT,
    "salary" TEXT,
    "description" TEXT,
    "notes" TEXT,
    "is_hot" BOOLEAN NOT NULL DEFAULT false,
    "openings" INTEGER NOT NULL DEFAULT 1,
    "openings_available" INTEGER NOT NULL DEFAULT 1,
    "start_date" TIMESTAMPTZ,
    "city" TEXT,
    "state" TEXT,
    "recruiter_id" UUID,
    "owner_id" UUID,
    "entered_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Requisition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requisition"."RequisitionAssignment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by_id" UUID,

    CONSTRAINT "RequisitionAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Requisition_tenant_id_status_idx" ON "requisition"."Requisition"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "Requisition_tenant_id_company_id_idx" ON "requisition"."Requisition"("tenant_id", "company_id");

-- CreateIndex
CREATE INDEX "Requisition_tenant_id_site_id_idx" ON "requisition"."Requisition"("tenant_id", "site_id");

-- CreateIndex
CREATE INDEX "Requisition_tenant_id_is_hot_idx" ON "requisition"."Requisition"("tenant_id", "is_hot");

-- CreateIndex
CREATE INDEX "RequisitionAssignment_tenant_id_user_id_idx" ON "requisition"."RequisitionAssignment"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "RequisitionAssignment_tenant_id_requisition_id_idx" ON "requisition"."RequisitionAssignment"("tenant_id", "requisition_id");

-- CreateIndex
CREATE UNIQUE INDEX "RequisitionAssignment_requisition_id_user_id_key" ON "requisition"."RequisitionAssignment"("requisition_id", "user_id");

-- AddForeignKey (intra-schema only)
ALTER TABLE "requisition"."RequisitionAssignment" ADD CONSTRAINT "RequisitionAssignment_requisition_id_fkey" FOREIGN KEY ("requisition_id") REFERENCES "requisition"."Requisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
