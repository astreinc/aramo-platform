-- Company-Fields v1.1 — additive Company field expansion (firmographics,
-- relationship, lifecycle, contact, activity rollup) + the gated commercial
-- layer (R3: markup canonical, perm fee separate, currency present).
--
-- ADDITIVE ONLY: ALTER TABLE ADD COLUMN (all nullable or DEFAULTed) + one
-- CREATE INDEX. No column drop, no type change to an existing column, no FK,
-- no enum (String-not-enum — closed vocabularies are TEXT). Existing rows
-- backfill via the column DEFAULTs: status='active', exclusivity=false,
-- tags='{}'. The dev tenant has 0 companies (no-op there); correct for any
-- real tenant. Core-untouched (only the company schema is altered).

-- AlterTable — un-gated columns
ALTER TABLE "company"."Company"
    ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN "description" TEXT,
    ADD COLUMN "industry" TEXT,
    ADD COLUMN "employee_count_band" TEXT,
    ADD COLUMN "annual_revenue_band" TEXT,
    ADD COLUMN "founded_year" INTEGER,
    ADD COLUMN "ownership_type" TEXT,
    ADD COLUMN "registration_number" TEXT,
    ADD COLUMN "source" TEXT,
    ADD COLUMN "client_tier" TEXT,
    ADD COLUMN "supplier_status" TEXT,
    ADD COLUMN "exclusivity" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "general_email" TEXT,
    ADD COLUMN "last_activity_at" TIMESTAMPTZ,
    ADD COLUMN "next_action_at" TIMESTAMPTZ;

-- AlterTable — gated commercial columns (visibility/writability per
-- company:read_commercial; see libs/field-masking + the repository write-strip)
ALTER TABLE "company"."Company"
    ADD COLUMN "fee_model" TEXT,
    ADD COLUMN "default_contract_markup_pct" DECIMAL(6,2),
    ADD COLUMN "default_perm_fee_pct" DECIMAL(5,2),
    ADD COLUMN "payment_terms" TEXT,
    ADD COLUMN "credit_status" TEXT,
    ADD COLUMN "default_currency" TEXT DEFAULT 'USD';

-- CreateIndex — status is the new primary list filter
CREATE INDEX "Company_tenant_id_status_idx"
    ON "company"."Company"("tenant_id", "status");
