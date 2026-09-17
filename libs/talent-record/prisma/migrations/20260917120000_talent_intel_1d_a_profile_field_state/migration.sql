-- TALENT-INTEL-1 TI-1D-A — TalentProfileFieldState: per-field CONTROL state that
-- gates AUTOMATIC reconcile projection (explicit-clear / HOLD protection). It
-- records the recruiter INTENT for a field, NOT the field value. The current
-- value stays solely on the flat TalentRecord row (TalentRecord remains the sole
-- operational projection). Same-schema child of TalentRecord, Cascade purge.
--
-- CONTROL-ONLY columns at TI-1D-A (PO ruling): value_state, source_type,
-- projection_policy. The generalized columns (source_evidence_id,
-- resolution_status, resolution_reason, proposed_value) are DELIBERATELY absent
-- and arrive additively in TI-1D-B. Closed vocabularies are enforced by the
-- WRITER (TS union), not a DB CHECK -- the talent_record String-vocabulary
-- precedent (see talent_record_field_provenance). Additive-only: no existing
-- table or column is mutated.

-- CreateTable
CREATE TABLE "talent_record"."talent_profile_field_state" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "talent_record_id" UUID NOT NULL,
    "field_key" TEXT NOT NULL,
    "value_state" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "projection_policy" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "talent_profile_field_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "talent_profile_field_state_tenant_record_field_key_key" ON "talent_record"."talent_profile_field_state"("tenant_id", "talent_record_id", "field_key");

-- CreateIndex
CREATE INDEX "talent_profile_field_state_tenant_record_idx" ON "talent_record"."talent_profile_field_state"("tenant_id", "talent_record_id");

-- AddForeignKey
ALTER TABLE "talent_record"."talent_profile_field_state" ADD CONSTRAINT "talent_profile_field_state_talent_record_id_fkey" FOREIGN KEY ("talent_record_id") REFERENCES "talent_record"."TalentRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
