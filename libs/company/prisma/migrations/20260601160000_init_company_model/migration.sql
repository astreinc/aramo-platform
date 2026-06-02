-- PR-A2 Gate 5 — initial migration for the `company` PG schema namespace.
-- Additive at the DB level: CREATE SCHEMA + CREATE TABLE only.
-- Nothing in any existing namespace is altered (Core-untouched, per the
-- directive §6 acceptance).
--
-- New PG schema: `company` — sixteenth namespace in the workspace.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "company";

-- CreateTable
CREATE TABLE "company"."Company" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "site_id" UUID,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "address2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "zip" TEXT,
    "phone1" TEXT,
    "phone2" TEXT,
    "fax_number" TEXT,
    "url" TEXT,
    "key_technologies" TEXT,
    "notes" TEXT,
    "is_hot" BOOLEAN NOT NULL DEFAULT false,
    "billing_contact_id" UUID,
    "owner_id" UUID,
    "entered_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company"."CompanyDepartment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "site_id" UUID,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyDepartment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Company_tenant_id_name_idx" ON "company"."Company"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "Company_tenant_id_site_id_idx" ON "company"."Company"("tenant_id", "site_id");

-- CreateIndex
CREATE INDEX "Company_tenant_id_is_hot_idx" ON "company"."Company"("tenant_id", "is_hot");

-- CreateIndex
CREATE INDEX "CompanyDepartment_tenant_id_company_id_idx" ON "company"."CompanyDepartment"("tenant_id", "company_id");

-- CreateIndex
CREATE INDEX "CompanyDepartment_tenant_id_site_id_idx" ON "company"."CompanyDepartment"("tenant_id", "site_id");

-- AddForeignKey (intra-schema only; cross-schema refs stay UUID-only per §7.3)
ALTER TABLE "company"."CompanyDepartment" ADD CONSTRAINT "CompanyDepartment_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"."Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
