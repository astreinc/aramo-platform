-- Promotion Gate Slice-B1 — the reconcile projection annotations.
--
-- OPEN-2 keeps L3 (TalentRecord) as the cheap single-row current projection.
-- L2 (EvidenceRecord) is the retained history. These two tables carry the
-- projection metadata WITHOUT an L3 version/event/log table:
--   - talent_record_field_provenance: which L2 EvidenceRecord currently
--     projects each enriched field (I10 provenance by reference).
--   - talent_record_reconcile_contradiction: pending (field, new evidence)
--     pairs where a re-arrival differs from an occupied field. B1 records the
--     pending contradiction and B2 consumes it.
--
-- Both are same-schema children of TalentRecord (real FK, onDelete Cascade —
-- purge-with-record). evidence_id / new_evidence_id are cross-schema UUID-only
-- refs to talent_trust.EvidenceRecord (no FK, Architecture §7.3 / I1).
-- Additive-only. No existing table or column mutated.

-- CreateTable
CREATE TABLE "talent_record"."talent_record_field_provenance" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "talent_record_id" UUID NOT NULL,
    "field_name" TEXT NOT NULL,
    "evidence_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "talent_record_field_provenance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_record"."talent_record_reconcile_contradiction" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "talent_record_id" UUID NOT NULL,
    "field_name" TEXT NOT NULL,
    "new_evidence_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "talent_record_reconcile_contradiction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "talent_record_field_provenance_talent_record_id_field_name_key" ON "talent_record"."talent_record_field_provenance"("talent_record_id", "field_name");

-- CreateIndex
CREATE INDEX "talent_record_field_provenance_tenant_id_idx" ON "talent_record"."talent_record_field_provenance"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "talent_record_reconcile_contradiction_talent_record_id_field_ne_key" ON "talent_record"."talent_record_reconcile_contradiction"("talent_record_id", "field_name", "new_evidence_id");

-- CreateIndex
CREATE INDEX "talent_record_reconcile_contradiction_tenant_id_status_idx" ON "talent_record"."talent_record_reconcile_contradiction"("tenant_id", "status");

-- AddForeignKey
ALTER TABLE "talent_record"."talent_record_field_provenance" ADD CONSTRAINT "talent_record_field_provenance_talent_record_id_fkey" FOREIGN KEY ("talent_record_id") REFERENCES "talent_record"."TalentRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "talent_record"."talent_record_reconcile_contradiction" ADD CONSTRAINT "talent_record_reconcile_contradiction_talent_record_id_fkey" FOREIGN KEY ("talent_record_id") REFERENCES "talent_record"."TalentRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
