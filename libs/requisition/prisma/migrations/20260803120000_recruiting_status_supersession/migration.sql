-- Track 1 T1-d — supersede "requisition"."RequisitionStatus" with
-- "requisition"."RecruitingStatus" (the DECLARED lifecycle only). CapacityStatus
-- is Track 4 and is deliberately NOT created here.
--
-- Value crosswalk (PO ruling): active -> open, full -> submittals_closed. lead
-- retained as the functional intake state. on_hold/closed/canceled unchanged.
-- New subsystem-gated values draft/pending_approval/archived are added to the
-- type but carry no transition-in and no policy row until their subsystems land.
--
-- T0 (tenant-reset) emptied the requisitions, so no backfill is required. The
-- USING remap below is nonetheless data-preserving and safe for any row that
-- survives -- the enum type is schema-global, so this must not assume a specific
-- tenant is the only occupant. active/full remap by CASE, every other label
-- carries across unchanged.
--
-- No literal semicolons appear in comment lines (migration-splitter hygiene).

-- CreateEnum
CREATE TYPE "requisition"."RecruitingStatus" AS ENUM ('lead', 'draft', 'pending_approval', 'open', 'on_hold', 'submittals_closed', 'canceled', 'closed', 'archived');

-- AlterTable: Requisition.status off the old type, remapping superseded labels.
ALTER TABLE "requisition"."Requisition" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "requisition"."Requisition"
  ALTER COLUMN "status" TYPE "requisition"."RecruitingStatus"
  USING (CASE "status"::text
    WHEN 'active' THEN 'open'
    WHEN 'full' THEN 'submittals_closed'
    ELSE "status"::text
  END::"requisition"."RecruitingStatus");
ALTER TABLE "requisition"."Requisition" ALTER COLUMN "status" SET DEFAULT 'open';

-- AlterTable: RequisitionLifecycleEvent history columns (T1-c), same remap.
-- ALTER TABLE IF EXISTS: some curated integration-test migration sets apply the
-- requisition init WITHOUT the lifecycle-event table. When it is absent Postgres
-- skips the statement (a NOTICE, not an error) -- there is then nothing to
-- convert and no dependency on the old type, so the DROP TYPE below still holds.
-- No DO/dollar-quote block is used, so naive semicolon-splitting migration
-- runners (splitDdl) execute each statement whole.
ALTER TABLE IF EXISTS "requisition"."RequisitionLifecycleEvent"
  ALTER COLUMN "previous_status" TYPE "requisition"."RecruitingStatus"
  USING (CASE "previous_status"::text
    WHEN 'active' THEN 'open'
    WHEN 'full' THEN 'submittals_closed'
    ELSE "previous_status"::text
  END::"requisition"."RecruitingStatus");
ALTER TABLE IF EXISTS "requisition"."RequisitionLifecycleEvent"
  ALTER COLUMN "next_status" TYPE "requisition"."RecruitingStatus"
  USING (CASE "next_status"::text
    WHEN 'active' THEN 'open'
    WHEN 'full' THEN 'submittals_closed'
    ELSE "next_status"::text
  END::"requisition"."RecruitingStatus");

-- DropEnum: retire the superseded type now that no column depends on it.
DROP TYPE "requisition"."RequisitionStatus";
