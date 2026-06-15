-- Talent Record Spec Amendment (stated-fields) v1.0 LOCKED — two talent-STATED
-- categorical CRM fields on the ATS TalentRecord projection.
--   availability_status {available_now|open_to_offers|not_looking|unknown}
--   engagement_type     {contract_to_hire|contract|direct_hire}
-- §5: String + closed vocabulary (NOT Prisma enums); validation is the
-- @IsIn-intent guard in the repository (closed-set), with btree indexes for the
-- Segment-4 server-side facet/sort. §6: ATS projection only — NO Core write.
-- ADDITIVE: two nullable columns, no backfill, no data-gated drop.

ALTER TABLE "talent_record"."TalentRecord"
  ADD COLUMN "availability_status" TEXT,
  ADD COLUMN "engagement_type" TEXT;

CREATE INDEX "TalentRecord_tenant_id_availability_status_idx"
  ON "talent_record"."TalentRecord" ("tenant_id", "availability_status");

CREATE INDEX "TalentRecord_tenant_id_engagement_type_idx"
  ON "talent_record"."TalentRecord" ("tenant_id", "engagement_type");
