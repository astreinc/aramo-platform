-- Job-Module Directive v1.0 + Amendment v1.1 — enterprise Requisition field
-- expansion + gated financial-planning fields + the GoldenProfile seam.
--
-- ADDITIVE ONLY: ALTER TABLE ADD COLUMN (all nullable / defaulted) + two
-- CREATE INDEX. NO destructive change (LB-1 entity retirement was DROPPED
-- by Amendment v1.1 — its premise was falsified). NO job_domain schema
-- change (GoldenProfile is typed at the DTO layer over its existing Json
-- columns; the matching-spine read path is NOT touched). Exactly ONE
-- migration, per Amendment v1.1 gate 9.
--
-- Three groups:
--   1. Enterprise role-content fields (UN-gated) — classification, work
--      arrangement, duration/schedule, source/VMS-ready stub.
--   2. Gated financial-planning fields (🔒 requisition:*:financials, LB-4)
--      — targets / ranges / rate-card stub ref. A DISTINCT surface from
--      the 13 compensation actuals (kept out of the D5 non-invertibility
--      family by design — own scope, own field set).
--   3. The seam column golden_profile_id (cross-schema UUID, no FK, §7.3)
--      — NULL until an explicit Generate-profile/confirm mints the profile.

-- AlterTable — group 1: enterprise role-content fields (un-gated).
ALTER TABLE "requisition"."Requisition"
    ADD COLUMN "job_type" TEXT,
    ADD COLUMN "labor_category" TEXT,
    ADD COLUMN "role_family" TEXT,
    ADD COLUMN "seniority_level" TEXT,
    ADD COLUMN "headcount_reason" TEXT,
    ADD COLUMN "work_arrangement" TEXT,
    ADD COLUMN "travel_percent" INTEGER,
    ADD COLUMN "relocation_offered" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "work_authorization" TEXT,
    ADD COLUMN "end_date" TIMESTAMPTZ,
    ADD COLUMN "duration_value" INTEGER,
    ADD COLUMN "duration_unit" TEXT,
    ADD COLUMN "extension_possible" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "hours_per_week" INTEGER,
    ADD COLUMN "source_system" TEXT,
    ADD COLUMN "external_req_id" TEXT,
    ADD COLUMN "imported_at" TIMESTAMPTZ;

-- AlterTable — group 2: gated financial-planning fields (🔒).
ALTER TABLE "requisition"."Requisition"
    ADD COLUMN "target_margin_percent" DECIMAL(5, 2),
    ADD COLUMN "markup_percent_target" DECIMAL(5, 2),
    ADD COLUMN "rate_card_id" UUID,
    ADD COLUMN "min_bill_rate" DECIMAL(12, 2),
    ADD COLUMN "max_bill_rate" DECIMAL(12, 2),
    ADD COLUMN "min_pay_rate" DECIMAL(12, 2),
    ADD COLUMN "max_pay_rate" DECIMAL(12, 2);

-- AlterTable — group 3: the GoldenProfile seam (cross-schema, no FK).
ALTER TABLE "requisition"."Requisition"
    ADD COLUMN "golden_profile_id" UUID;

-- CreateIndex — the two new query predicates (job_type filter, VMS source).
CREATE INDEX "Requisition_tenant_id_job_type_idx"
    ON "requisition"."Requisition"("tenant_id", "job_type");

CREATE INDEX "Requisition_tenant_id_source_system_idx"
    ON "requisition"."Requisition"("tenant_id", "source_system");
