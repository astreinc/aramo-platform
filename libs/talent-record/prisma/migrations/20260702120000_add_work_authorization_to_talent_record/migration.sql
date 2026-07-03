-- Gate-1 G1-A (R6) — talent-STATED work_authorization on the ATS TalentRecord
-- projection. String + closed vocabulary reusing talent_evidence's
-- TalentWorkAuthorizationStatus values (US_CITIZEN | PERMANENT_RESIDENT |
-- VISA_HOLDER | REQUIRES_SPONSORSHIP | OTHER | NOT_DISCLOSED); validation is the
-- @IsIn-intent guard in the repository (closed-set). Btree index for the
-- Segment-4 server-side facet/sort, mirroring the stated-fields precedent.
-- ADDITIVE: one nullable column, no backfill, no data-gated drop. ATS
-- projection only — NO Core write.

ALTER TABLE "talent_record"."TalentRecord"
  ADD COLUMN "work_authorization" TEXT;

CREATE INDEX "TalentRecord_tenant_id_work_authorization_idx"
  ON "talent_record"."TalentRecord" ("tenant_id", "work_authorization");
