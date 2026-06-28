-- TR-1 — Trust Model & Vocabulary (foundation slice). Initial talent_trust
-- schema: the append-only evidence ledger + lifecycle event log + first-class
-- evidence links + the materialized TrustState rollup.
--
-- Closed vocabularies are TEXT columns (PO Ruling 2 — no native Prisma enums).
-- The allowed values are enforced at the DTO layer (@IsIn) and documented in
-- the Prisma schema `///` comments.
--
-- Intra-schema relations carry real FKs (the cross-schema no-FK rule,
-- Architecture §7.3, applies only ACROSS schemas). External references
-- (ResolutionSubjectRef.ref_id, EvidenceEvent.linked_evidence_id, EvidenceLink
-- .from/to_evidence_id) are UUID-only with no FK.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "talent_trust";

-- CreateTable
CREATE TABLE "talent_trust"."ResolutionSubject" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "merged_into_subject_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResolutionSubject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_trust"."ResolutionSubjectRef" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "link_source" TEXT NOT NULL,

    CONSTRAINT "ResolutionSubjectRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_trust"."EvidenceRecord" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "dimension" TEXT NOT NULL,
    "assertion_type" TEXT NOT NULL,
    "assertion_payload" JSONB NOT NULL,
    "source_class" TEXT NOT NULL,
    "source_ref" JSONB,
    "method" TEXT NOT NULL,
    "strength" DOUBLE PRECISION NOT NULL,
    "collected_at" TIMESTAMPTZ NOT NULL,
    "decay_profile" TEXT NOT NULL,
    "portability_class" TEXT NOT NULL,
    "ai_derived" BOOLEAN NOT NULL DEFAULT false,
    "current_status" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_trust"."EvidenceEvent" (
    "id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "reason" TEXT,
    "linked_evidence_id" UUID,
    "actor" TEXT,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_trust"."EvidenceLink" (
    "id" UUID NOT NULL,
    "from_evidence_id" UUID NOT NULL,
    "to_evidence_id" UUID NOT NULL,
    "relation" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "talent_trust"."TrustState" (
    "subject_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "identity_band" TEXT NOT NULL,
    "claims_band" TEXT NOT NULL,
    "continuity_band" TEXT NOT NULL,
    "eligibility_band" TEXT NOT NULL,
    "open_contradiction_count" INTEGER NOT NULL DEFAULT 0,
    "stale_evidence_count" INTEGER NOT NULL DEFAULT 0,
    "has_open_dispute" BOOLEAN NOT NULL DEFAULT false,
    "last_recomputed_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "TrustState_pkey" PRIMARY KEY ("subject_id")
);

-- CreateIndex
CREATE INDEX "ResolutionSubject_tenant_id_idx" ON "talent_trust"."ResolutionSubject"("tenant_id");
CREATE INDEX "ResolutionSubject_tenant_id_status_idx" ON "talent_trust"."ResolutionSubject"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ResolutionSubjectRef_tenant_id_ref_type_ref_id_key" ON "talent_trust"."ResolutionSubjectRef"("tenant_id", "ref_type", "ref_id");
CREATE INDEX "ResolutionSubjectRef_subject_id_idx" ON "talent_trust"."ResolutionSubjectRef"("subject_id");
CREATE INDEX "ResolutionSubjectRef_tenant_id_idx" ON "talent_trust"."ResolutionSubjectRef"("tenant_id");

-- CreateIndex
CREATE INDEX "EvidenceRecord_tenant_id_subject_id_idx" ON "talent_trust"."EvidenceRecord"("tenant_id", "subject_id");
CREATE INDEX "EvidenceRecord_tenant_id_subject_id_dimension_idx" ON "talent_trust"."EvidenceRecord"("tenant_id", "subject_id", "dimension");

-- CreateIndex
CREATE INDEX "EvidenceEvent_tenant_id_evidence_id_occurred_at_idx" ON "talent_trust"."EvidenceEvent"("tenant_id", "evidence_id", "occurred_at");

-- CreateIndex
CREATE INDEX "EvidenceLink_tenant_id_from_evidence_id_idx" ON "talent_trust"."EvidenceLink"("tenant_id", "from_evidence_id");
CREATE INDEX "EvidenceLink_tenant_id_to_evidence_id_idx" ON "talent_trust"."EvidenceLink"("tenant_id", "to_evidence_id");

-- CreateIndex
CREATE INDEX "TrustState_tenant_id_idx" ON "talent_trust"."TrustState"("tenant_id");

-- AddForeignKey (intra-schema only)
ALTER TABLE "talent_trust"."ResolutionSubjectRef" ADD CONSTRAINT "ResolutionSubjectRef_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "talent_trust"."ResolutionSubject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "talent_trust"."EvidenceRecord" ADD CONSTRAINT "EvidenceRecord_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "talent_trust"."ResolutionSubject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "talent_trust"."EvidenceEvent" ADD CONSTRAINT "EvidenceEvent_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "talent_trust"."EvidenceRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "talent_trust"."TrustState" ADD CONSTRAINT "TrustState_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "talent_trust"."ResolutionSubject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- EvidenceRecord assertion-content immutability (DoD). Belt-and-suspenders
-- alongside the repository (which exposes only updateEvidenceStatus). The
-- BEFORE UPDATE trigger rejects any change to a column other than
-- current_status — assertion content is immutable once written (§5.1).
-- ============================================================================
CREATE OR REPLACE FUNCTION talent_trust.evidence_record_assertion_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.dimension IS DISTINCT FROM OLD.dimension
     OR NEW.assertion_type IS DISTINCT FROM OLD.assertion_type
     OR NEW.assertion_payload IS DISTINCT FROM OLD.assertion_payload
     OR NEW.source_class IS DISTINCT FROM OLD.source_class
     OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.strength IS DISTINCT FROM OLD.strength
     OR NEW.collected_at IS DISTINCT FROM OLD.collected_at
     OR NEW.decay_profile IS DISTINCT FROM OLD.decay_profile
     OR NEW.portability_class IS DISTINCT FROM OLD.portability_class
     OR NEW.ai_derived IS DISTINCT FROM OLD.ai_derived
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'EvidenceRecord assertion content is immutable; only current_status may change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_record_assertion_immutable
  BEFORE UPDATE ON talent_trust."EvidenceRecord"
  FOR EACH ROW EXECUTE FUNCTION talent_trust.evidence_record_assertion_immutable();

-- ============================================================================
-- EvidenceEvent / EvidenceLink append-only immutability. Status only ever
-- changes by APPENDING an EvidenceEvent — events and links are never updated.
-- ============================================================================
CREATE OR REPLACE FUNCTION talent_trust.evidence_event_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'EvidenceEvent is append-only; UPDATE rejected';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_event_no_update
  BEFORE UPDATE ON talent_trust."EvidenceEvent"
  FOR EACH ROW EXECUTE FUNCTION talent_trust.evidence_event_immutable();

CREATE OR REPLACE FUNCTION talent_trust.evidence_link_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'EvidenceLink is append-only; UPDATE rejected';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_link_no_update
  BEFORE UPDATE ON talent_trust."EvidenceLink"
  FOR EACH ROW EXECUTE FUNCTION talent_trust.evidence_link_immutable();
