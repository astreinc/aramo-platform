-- CreateIndex
CREATE INDEX "TalentJobExamination_tenant_id_job_id_tier_rank_ordinal_idx" ON "examination"."TalentJobExamination"("tenant_id", "job_id", "tier", "rank_ordinal");

