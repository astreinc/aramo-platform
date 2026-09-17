-- TALENT-INTEL-1 TI-1D-B — the generalized field-resolution SUMMARY columns on
-- talent_profile_field_state, deferred additively from TI-1D-A. These record the
-- CURRENT resolution state of a per-field review, NOT its history (the append-only
-- lifecycle stays in talent_record_reconcile_contradiction, and no history migrates
-- here). source_evidence_id is DELIBERATELY NOT added -- talent_record_field_provenance
-- remains the sole evidence-linkage authority (the read model joins through it).
--
-- resolution_status: NONE | PENDING_REVIEW | RESOLVED (NOT NULL, default NONE so
-- every existing TI-1D-A control row reads as NONE). resolution_reason:
-- EVIDENCE_CONFLICT | ACCEPTED_PROPOSED | KEPT_CURRENT | MANUAL_CONFIRMATION
-- (nullable). proposed_value: the value reconcile would have projected, populated
-- ONLY while PENDING_REVIEW, cleared on resolve -- never Talent truth. Closed
-- vocabularies enforced by the WRITER (TS union), not a DB CHECK (talent_record
-- String-vocabulary precedent). Additive-only: no existing column is mutated.

-- AlterTable
ALTER TABLE "talent_record"."talent_profile_field_state"
    ADD COLUMN "resolution_status" TEXT NOT NULL DEFAULT 'NONE',
    ADD COLUMN "resolution_reason" TEXT,
    ADD COLUMN "proposed_value" TEXT;
