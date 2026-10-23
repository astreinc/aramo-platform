-- ATI-SEP-1 T8 (ADR-0036 §3 "TI -> ATS"). Additive only, ADD-not-rename.
--
--   1. intelligence_link — the ATS side of the TI subject link: one row per
--      (tenant, talent), the Golden subject id TI resolved for it. UUID-only
--      reference into the TI database (no FK to TI; a different database).
--      Same-schema child of TalentRecord (Cascade purge, the provenance precedent).
--   2. talent_intelligence_inbound_event — the inbox of the HMAC-signed TI
--      webhook (golden_talent.profile_updated). Keyed on the delivery event_id
--      (idempotent receive); the worker drains RECEIVED rows under a lease.
--   3. talent_intelligence_sync_policy — the per-tenant inbound field sync
--      policy (AUTO_APPLY | REVIEW | IGNORE). A missing row = the code default.
--   4. source_kind on talent_record_field_provenance and
--      talent_record_reconcile_contradiction — TRUST_EVIDENCE (every existing
--      row: evidence_id / new_evidence_id is a talent_trust.EvidenceRecord id)
--      or INTELLIGENCE (the id is a TI-derived reference, never a trust row).
--      The trust contradiction poll reads TRUST_EVIDENCE rows only.
--
-- No returned API shape changes: none of these tables or columns is projected.

-- 1.
CREATE TABLE "talent_record"."intelligence_link" (
  "tenant_id" UUID NOT NULL,
  "talent_record_id" UUID NOT NULL,
  "intelligence_subject_id" UUID NOT NULL,
  "linked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_synced_at" TIMESTAMPTZ,
  CONSTRAINT "intelligence_link_pkey" PRIMARY KEY ("tenant_id", "talent_record_id"),
  CONSTRAINT "intelligence_link_talent_record_id_fkey" FOREIGN KEY ("talent_record_id")
    REFERENCES "talent_record"."TalentRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "intelligence_link_intelligence_subject_id_idx"
  ON "talent_record"."intelligence_link" ("intelligence_subject_id");

-- 2.
CREATE TABLE "talent_record"."talent_intelligence_inbound_event" (
  "event_id" TEXT NOT NULL,
  "tenant_id" UUID NOT NULL,
  "talent_record_id" UUID NOT NULL,
  "intelligence_subject_id" UUID NOT NULL,
  "changed_fact_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "occurred_at" TIMESTAMPTZ NOT NULL,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "outcome" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lease_expires_at" TIMESTAMPTZ,
  "processed_at" TIMESTAMPTZ,
  "last_error" TEXT,
  CONSTRAINT "talent_intelligence_inbound_event_pkey" PRIMARY KEY ("event_id")
);

CREATE INDEX "talent_intelligence_inbound_event_tenant_id_talent_record_id_idx"
  ON "talent_record"."talent_intelligence_inbound_event" ("tenant_id", "talent_record_id");

-- Claim-scan index: only rows still to process, oldest first.
CREATE INDEX "talent_intelligence_inbound_event_claimable_idx"
  ON "talent_record"."talent_intelligence_inbound_event" ("received_at")
  WHERE "status" = 'RECEIVED';

-- 3.
CREATE TABLE "talent_record"."talent_intelligence_sync_policy" (
  "tenant_id" UUID NOT NULL,
  "field_key" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_by" UUID,
  CONSTRAINT "talent_intelligence_sync_policy_pkey" PRIMARY KEY ("tenant_id", "field_key"),
  CONSTRAINT "talent_intelligence_sync_policy_mode_check" CHECK ("mode" IN ('AUTO_APPLY', 'REVIEW', 'IGNORE'))
);

-- 4.
ALTER TABLE "talent_record"."talent_record_field_provenance"
  ADD COLUMN "source_kind" TEXT NOT NULL DEFAULT 'TRUST_EVIDENCE';

ALTER TABLE "talent_record"."talent_record_reconcile_contradiction"
  ADD COLUMN "source_kind" TEXT NOT NULL DEFAULT 'TRUST_EVIDENCE',
  ADD COLUMN "proposed_value" TEXT;
