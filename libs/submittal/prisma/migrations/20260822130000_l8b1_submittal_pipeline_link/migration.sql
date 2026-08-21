-- L8-B1 Amendment A1 (R-LINK) — the stored Submittal to Pipeline episode
-- association. Nullable cross-schema UUID reference (no FK, Architecture §7.3)
-- to pipeline.Pipeline.id. MANY submittals to ONE pipeline episode. Backward
-- compatible: existing rows are NULL until associated. Governed by
-- Aramo-Requisition-Submittal-Eligibility-Implementation-Directive-v1_0-LOCKED v1.2.

-- AlterTable
ALTER TABLE "submittal"."TalentSubmittalRecord" ADD COLUMN "pipeline_id" UUID;

-- CreateIndex
CREATE INDEX "TalentSubmittalRecord_tenant_id_pipeline_id_idx" ON "submittal"."TalentSubmittalRecord"("tenant_id", "pipeline_id");
