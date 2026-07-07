-- TR-2a-B3b (DDR-3 §6) — the SubjectMergeOperation record.
--
-- The durable checkpoint / reversal source / TR-6 merge-audit first increment
-- for a record-reconcile (phase 2 of a both-/one-promoted merge). Record ids are
-- bare UUIDs (I1-clean, no cross-schema FK). Sweep/ref/collision progress is JSONB
-- (small volumes at this stage). Additive-only — no existing table touched.

-- CreateTable
CREATE TABLE "talent_trust"."SubjectMergeOperation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "advisory_id" UUID,
    "surviving_subject_id" UUID NOT NULL,
    "merged_subject_id" UUID NOT NULL,
    "surviving_record_id" UUID,
    "superseded_record_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "ref_actions" JSONB NOT NULL DEFAULT '[]',
    "sweep_steps" JSONB NOT NULL DEFAULT '[]',
    "collision_records" JSONB NOT NULL DEFAULT '[]',
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,
    "reversed_at" TIMESTAMPTZ,
    "reversed_by" TEXT,
    "reversal_justification" TEXT,
    "post_merge_accretions" JSONB,

    CONSTRAINT "SubjectMergeOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SubjectMergeOperation_tenant_id_status_idx" ON "talent_trust"."SubjectMergeOperation"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "SubjectMergeOperation_tenant_id_surviving_subject_id_idx" ON "talent_trust"."SubjectMergeOperation"("tenant_id", "surviving_subject_id");

-- CreateIndex
CREATE INDEX "SubjectMergeOperation_advisory_id_idx" ON "talent_trust"."SubjectMergeOperation"("advisory_id");
