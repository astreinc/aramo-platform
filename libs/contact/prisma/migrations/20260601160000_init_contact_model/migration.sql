-- PR-A2 Gate 5 — initial migration for the `contact` PG schema namespace.
-- Additive at the DB level: CREATE SCHEMA + CREATE TABLE only.
-- Nothing in any existing namespace is altered (Core-untouched).
--
-- New PG schema: `contact` — seventeenth namespace in the workspace.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "contact";

-- CreateTable
CREATE TABLE "contact"."Contact" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "site_id" UUID,
    "company_id" UUID NOT NULL,
    "company_department_id" UUID,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "title" TEXT,
    "email1" TEXT,
    "email2" TEXT,
    "phone_work" TEXT,
    "phone_cell" TEXT,
    "phone_other" TEXT,
    "address" TEXT,
    "address2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "is_hot" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "left_company" BOOLEAN NOT NULL DEFAULT false,
    "reports_to_id" UUID,
    "owner_id" UUID,
    "entered_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Contact_tenant_id_company_id_idx" ON "contact"."Contact"("tenant_id", "company_id");

-- CreateIndex
CREATE INDEX "Contact_tenant_id_last_name_first_name_idx" ON "contact"."Contact"("tenant_id", "last_name", "first_name");

-- CreateIndex
CREATE INDEX "Contact_tenant_id_site_id_idx" ON "contact"."Contact"("tenant_id", "site_id");

-- CreateIndex
CREATE INDEX "Contact_tenant_id_is_hot_idx" ON "contact"."Contact"("tenant_id", "is_hot");
