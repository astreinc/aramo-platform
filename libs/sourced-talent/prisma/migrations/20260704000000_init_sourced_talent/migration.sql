-- Fix-Slice-1 (Staging Front Door) — initial sourced_talent schema: the L1
-- per-arrival staging table (Talent-Lifecycle and Trust Architecture Spec v1.1
-- Section 3.1 / Section 2 L1). One row per channel-arrival, raw and immutable,
-- carrying provenance + legal basis. This is the landing substrate a sourced
-- arrival accrues evidence against BEFORE promotion to a TalentRecord (via a
-- SOURCED_TALENT ResolutionSubjectRef in talent_trust).
--
-- L1 IS TENANT-SCOPED — carries tenant_id. This is NOT identity_index: the I14
-- no-tenant_id/no-PII cross-tenant wall does NOT apply here. L1 lands inside
-- the tenant wall (Spec Section 2). Cross-schema references are UUID-only, no
-- FK (Architecture Section 7.3). This schema has no intra-schema relations.
--
-- IMMUTABILITY: a sourced arrival is raw + immutable (Spec Section 2). A
-- whole-row BEFORE UPDATE trigger rejects any UPDATE (mirrors the talent_trust
-- EvidenceEvent/EvidenceLink append-only precedent).

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "sourced_talent";

-- CreateTable
CREATE TABLE "sourced_talent"."SourcedTalent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "source_channel" TEXT NOT NULL,
    "external_source_id" TEXT NOT NULL,
    "provenance" JSONB NOT NULL,
    "legal_basis" JSONB NOT NULL,
    "arrived_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SourcedTalent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SourcedTalent_tenant_source_external_key" ON "sourced_talent"."SourcedTalent"("tenant_id", "source_channel", "external_source_id");

-- CreateIndex
CREATE INDEX "SourcedTalent_tenant_id_idx" ON "sourced_talent"."SourcedTalent"("tenant_id");

-- CreateIndex
CREATE INDEX "SourcedTalent_tenant_id_source_channel_idx" ON "sourced_talent"."SourcedTalent"("tenant_id", "source_channel");

-- Append-only immutability — a sourced arrival is raw + immutable (Spec
-- Section 2). Any UPDATE is rejected.
CREATE OR REPLACE FUNCTION sourced_talent.sourced_talent_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'SourcedTalent is an immutable raw arrival; UPDATE rejected';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sourced_talent_no_update
  BEFORE UPDATE ON sourced_talent."SourcedTalent"
  FOR EACH ROW EXECUTE FUNCTION sourced_talent.sourced_talent_immutable();
