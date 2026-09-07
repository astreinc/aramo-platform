-- CI-B2 — Immutable Requisition Analysis Context init migration.
-- Per Aramo-CI-Conversation-Intelligence-Directive-v1_2-LOCKED.md §10 +
-- ADR-0031. conversation_intelligence schema with the
-- RequisitionAnalysisContextSnapshot immutable snapshot entity.
-- Cross-schema references (requisition_id, golden_profile_id) are
-- UUID-only per Architecture §7.3 (no FK constraints). Tenant
-- replication per §7.2. This is an ADDITIVE migration — a new schema
-- and a new table only, no change to any existing schema or table.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "conversation_intelligence";

-- CreateTable
CREATE TABLE "conversation_intelligence"."RequisitionAnalysisContextSnapshot" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requisition_id" UUID NOT NULL,
    "source_requisition_version" INTEGER NOT NULL,
    "golden_profile_id" UUID,
    "snapshot_schema_version" VARCHAR(64) NOT NULL,
    "context" JSONB NOT NULL,
    "captured_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequisitionAnalysisContextSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RequisitionAnalysisContextSnapshot_tenant_id_requisition_id_captured_at_idx" ON "conversation_intelligence"."RequisitionAnalysisContextSnapshot"("tenant_id", "requisition_id", "captured_at");

-- CreateIndex
CREATE INDEX "RequisitionAnalysisContextSnapshot_tenant_id_created_at_idx" ON "conversation_intelligence"."RequisitionAnalysisContextSnapshot"("tenant_id", "created_at");

-- ============================================================================
-- RequisitionAnalysisContextSnapshot immutability — CI-B2 directive §10.
-- Per directive §10 the snapshot is immutable, not generally editable
-- and never a mutable Requisition-history system. The entity has no
-- lifecycle column (no updated_at, no status), so the trigger is
-- whole-row unconditional — any UPDATE is rejected at the database
-- layer. Mechanism precedent: evidence TalentJobEvidencePackage (M4
-- PR-1, whole-row) and ai_draft AiDraftEvent (M5 PR-5). Belt-and-
-- suspenders: the RequisitionAnalysisContextSnapshotRepository surface
-- exposes create + reads only (no update / upsert / delete path).
-- NOTE: keep this comment block free of literal semicolons and free of
-- the dollar-quote delimiter sequence. The integration test setup
-- applies the migration via a dollar-quote-aware splitter that splits
-- on the statement terminator outside dollar-quoted regions but does
-- not strip line comments, so either token inside a comment confuses it.
-- ============================================================================
CREATE OR REPLACE FUNCTION conversation_intelligence.reject_requisition_analysis_context_snapshot_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'RequisitionAnalysisContextSnapshot is immutable per CI directive section 10; UPDATE not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_requisition_analysis_context_snapshot_update
  BEFORE UPDATE ON conversation_intelligence."RequisitionAnalysisContextSnapshot"
  FOR EACH ROW EXECUTE FUNCTION conversation_intelligence.reject_requisition_analysis_context_snapshot_update();
