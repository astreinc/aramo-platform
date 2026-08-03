-- T1-d (Track-1 section T1-d) — supersede RequisitionStatus with RecruitingStatus.
-- The DECLARED half of the Planning Package status split (CapacityStatus, the
-- derived half, lands at Track 4). Renames the type, remaps two values
-- (active to open, full to submittals_closed), retains lead, and adds three
-- present-but-inert values (draft, pending_approval, archived).
--
-- Strategy: drop-and-recreate. Safe ONLY because the requisition domain is empty
-- when this runs -- T0 (tenant reset) emptied production, and integration DBs
-- apply this on a freshly-migrated (rowless) schema. No status data is lost.
--
-- RequisitionLifecycleEvent is guarded with ALTER TABLE IF EXISTS: some
-- integration migration-sets create the Requisition table but not the lifecycle
-- table, and this migration must apply cleanly against either shape. Because the
-- schema is rowless when this runs, no value-remap of existing rows is needed
-- (the USING cast has nothing to convert). The two Requisition UPDATEs below are
-- correctness insurance for the always-present Requisition table only.
-- NOTE keep every comment in this file free of the statement-separator
-- character, because some integration harnesses split migration SQL on it and a
-- separator inside a comment would break the split.

-- 1. Detach the columns from the old enum type (drop the default first).
ALTER TABLE "requisition"."Requisition" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "requisition"."Requisition" ALTER COLUMN "status" TYPE TEXT USING "status"::TEXT;
ALTER TABLE IF EXISTS "requisition"."RequisitionLifecycleEvent" ALTER COLUMN "previous_status" TYPE TEXT USING "previous_status"::TEXT;
ALTER TABLE IF EXISTS "requisition"."RequisitionLifecycleEvent" ALTER COLUMN "next_status" TYPE TEXT USING "next_status"::TEXT;

-- 2. Replace the type (lifecycle order: pre-open, open, terminal, retention).
DROP TYPE "requisition"."RequisitionStatus";
CREATE TYPE "requisition"."RecruitingStatus" AS ENUM ('draft', 'pending_approval', 'lead', 'open', 'on_hold', 'submittals_closed', 'closed', 'canceled', 'archived');

-- 3. Remap the two renamed values on the always-present Requisition table
--    (no-op on the rowless schema this runs against, correct if a row exists).
UPDATE "requisition"."Requisition" SET "status" = 'open' WHERE "status" = 'active';
UPDATE "requisition"."Requisition" SET "status" = 'submittals_closed' WHERE "status" = 'full';

-- 4. Re-attach the columns to the new type.
ALTER TABLE "requisition"."Requisition" ALTER COLUMN "status" TYPE "requisition"."RecruitingStatus" USING "status"::"requisition"."RecruitingStatus";
ALTER TABLE IF EXISTS "requisition"."RequisitionLifecycleEvent" ALTER COLUMN "previous_status" TYPE "requisition"."RecruitingStatus" USING "previous_status"::"requisition"."RecruitingStatus";
ALTER TABLE IF EXISTS "requisition"."RequisitionLifecycleEvent" ALTER COLUMN "next_status" TYPE "requisition"."RecruitingStatus" USING "next_status"::"requisition"."RecruitingStatus";

-- 5. Restore the create-time default at the renamed value.
ALTER TABLE "requisition"."Requisition" ALTER COLUMN "status" SET DEFAULT 'open';
