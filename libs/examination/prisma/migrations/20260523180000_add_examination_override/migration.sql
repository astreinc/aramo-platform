-- M4 PR-5 §4.2 — ExaminationOverride table + OverrideType enum + ABSOLUTE
-- immutability trigger (Group 2 Baseline v2.0 §2.4-§2.5 — an override row
-- is never updated post-creation). Mirrors the M3 PR-2 TalentConsentEvent
-- unconditional-rejection trigger pattern, distinct from the M3 PR-1
-- TalentJobExamination column-scoped trigger which permits lifecycle
-- transitions. Override rows have no lifecycle.
--
-- CreateEnum
CREATE TYPE "examination"."OverrideType" AS ENUM ('tier', 'risk_flag', 'gap', 'constraint_check');

-- CreateTable
CREATE TABLE "examination"."ExaminationOverride" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "examination_id" UUID NOT NULL,
    "override_type" "examination"."OverrideType" NOT NULL,
    "target_field" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExaminationOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExaminationOverride_tenant_id_examination_id_idx" ON "examination"."ExaminationOverride"("tenant_id", "examination_id");

-- CreateIndex
CREATE INDEX "ExaminationOverride_tenant_id_created_at_idx" ON "examination"."ExaminationOverride"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "ExaminationOverride_tenant_id_created_by_idx" ON "examination"."ExaminationOverride"("tenant_id", "created_by");

-- ============================================================================
-- ExaminationOverride absolute-immutability trigger — M4 PR-5 §4.2.
-- Group 2 Baseline v2.0 §2.4-§2.5 require override rows to be immutable
-- post-creation. Unlike the M3 PR-1 TalentJobExamination column-scoped
-- trigger (which permits the active->archived->cold_storage lifecycle
-- transitions on lifecycle_state / archived_at / superseded_by), an
-- override row has NO lifecycle — every UPDATE is rejected unconditionally.
-- This mirrors the M3 PR-2 TalentConsentEvent unconditional-rejection
-- pattern.
-- NOTE keep this comment block free of literal semicolons and free of
-- the dollar-quote delimiter sequence (the dollar-quote-aware splitter
-- used by integration tests can be confused by either token in comments).
-- ============================================================================
CREATE OR REPLACE FUNCTION examination.reject_override_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'ExaminationOverride is absolutely immutable per Group 2 §2.4-§2.5; override rows are never updated post-creation'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_override_update
BEFORE UPDATE ON examination."ExaminationOverride"
FOR EACH ROW
EXECUTE FUNCTION examination.reject_override_update();
