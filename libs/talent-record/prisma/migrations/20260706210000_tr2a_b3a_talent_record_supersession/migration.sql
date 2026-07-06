-- TR-2a-B3a (DDR-3 §3) — record supersession substrate on TalentRecord.
--
-- A NEW lifecycle axis, deliberately SEPARATE from tenant_status. tenant_status
-- is the per-tenant RELATIONSHIP string (sourced/engaged) — it describes how the
-- tenant relates to the human. record_status is the record IDENTITY VALIDITY
-- axis — which record speaks for the human after a late merge. The two never
-- conflate.
--
-- Supersession is NOT deletion. This axis is NEVER the RTBF/delete path (that is
-- talent-record delete / deleteByImportBatch — erasure of what exists). A
-- superseded row persists with full content — it is the un-merge restore source
-- and the honest history. superseded_by_record_id points at the surviving record
-- so a stale link resolves informatively via findById.
--
-- Writer-less this slice (B3a is the read model) — no producer sets 'superseded'
-- yet, exactly as the SUPERSEDED subject status sat writer-less before its
-- reconcile. The reconcile writer (B3b) lands the producer. Additive-only — no
-- existing column mutated, DEFAULT 'live' back-fills every existing row.

-- AlterTable
ALTER TABLE "talent_record"."TalentRecord"
  ADD COLUMN "record_status" TEXT NOT NULL DEFAULT 'live',
  ADD COLUMN "superseded_by_record_id" UUID,
  ADD COLUMN "superseded_at" TIMESTAMPTZ;
