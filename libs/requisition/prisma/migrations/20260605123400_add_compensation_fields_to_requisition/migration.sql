-- Compensation-Field Modeling v1.1 — structured comp surface on
-- Requisition. ADDITIVE: CREATE TYPE (two new enums) + ALTER TABLE
-- ADD COLUMN (10 new nullable columns). NO data migration; the legacy
-- rate_max + salary free-text columns are PRESERVED (v1.1 §6 — they
-- coexist with the structured successors during the frontend
-- migration window). NO indexes added — the new fields are not query
-- predicates (no scope filters on them at this batch).
--
-- Per v1.1 §2.2 + §10 halt: the three derived views (margin_amount,
-- markup_percent, margin_percent) are NOT columns — they are
-- computed-on-read in projectView from the stored bill/pay facts.
-- Storing them re-introduces drift.

-- CreateEnum
CREATE TYPE "requisition"."RatePeriod" AS ENUM ('HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "requisition"."RequisitionCompensationModel" AS ENUM ('CONTRACT', 'PERMANENT');

-- AlterTable — discriminator + stored facts (CONTRACT) + perm fields.
ALTER TABLE "requisition"."Requisition"
    ADD COLUMN "compensation_model" "requisition"."RequisitionCompensationModel",
    ADD COLUMN "pay_rate_amount" DECIMAL(12, 2),
    ADD COLUMN "pay_rate_currency" TEXT,
    ADD COLUMN "pay_rate_period" "requisition"."RatePeriod",
    ADD COLUMN "bill_rate_amount" DECIMAL(12, 2),
    ADD COLUMN "bill_rate_currency" TEXT,
    ADD COLUMN "bill_rate_period" "requisition"."RatePeriod",
    ADD COLUMN "placement_fee_percent" DECIMAL(5, 2),
    ADD COLUMN "placement_fee_amount" DECIMAL(12, 2),
    ADD COLUMN "salary_amount" DECIMAL(12, 2),
    ADD COLUMN "salary_currency" TEXT;
