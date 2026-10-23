-- ATI-SEP-1 T10 WP2 — ATS-local sourcing. Additive only, ADD-not-rename.
--
-- canonicalize() now resolves each arrival to a sourced_talent.SourcedTalent row
-- (keyed by tenant + channel + external id) instead of the retired trust subject
-- and identity-index cluster. sourced_talent_id is the new idempotency anchor and
-- canonicalize poll gate. resolved_subject_id / resolved_cluster_id stay as INERT
-- soft refs (no longer written; historical values retained).
--
-- Cross-schema UUID-only reference (no FK, Architecture section 7.3).

-- AlterTable
ALTER TABLE "ingestion"."RawPayloadReference" ADD COLUMN "sourced_talent_id" UUID;

-- CreateIndex
CREATE INDEX "RawPayloadReference_tenant_id_sourced_talent_id_idx"
  ON "ingestion"."RawPayloadReference"("tenant_id", "sourced_talent_id");
