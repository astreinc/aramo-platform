-- ATI-SEP-1 T1 (ADR-0036 Sections 4-6, Addendum A1) — the Golden model in the
-- TI database. Applied ONLY by tools/db-sync-intelligence.sh.
-- Closed vocabularies are TEXT columns (talent-trust precedent, no native enums)
-- and the FIXED status vocabularies carry CHECK constraints. assertion_type is
-- extensible and is enforced in code (contracts ASSERTION_TYPES).
-- splitDdl-safe: no semicolons in comments.
-- CreateTable
CREATE TABLE "intelligence"."GoldenTalent" (
    "id" UUID NOT NULL,
    "resolution_status" TEXT NOT NULL DEFAULT 'PROVISIONAL',
    "merged_into_id" UUID,
    "access_state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoldenTalent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence"."SubjectIdentifier" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "identifier_type" TEXT NOT NULL,
    "normalized_value" TEXT NOT NULL,
    "jurisdiction" TEXT,
    "identifier_class" TEXT,
    "verification_status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verification_method" TEXT,
    "verification_source" TEXT,
    "verified_at" TIMESTAMPTZ(6),
    "valid_from" TIMESTAMPTZ(6),
    "valid_to" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "source_reference_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SubjectIdentifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence"."ExternalTalentReference" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "source_system_id" TEXT NOT NULL,
    "source_tenant_id" TEXT NOT NULL,
    "external_talent_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "linked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erased_at" TIMESTAMPTZ(6),
    "last_identity_snapshot" JSONB NOT NULL,

    CONSTRAINT "ExternalTalentReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence"."Assertion" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "assertion_type" TEXT NOT NULL,
    "admission_class" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "source_reference_id" UUID,
    "source_system_id" TEXT NOT NULL,
    "source_tenant_id" TEXT,
    "source_kind" TEXT NOT NULL,
    "source_event_id" TEXT NOT NULL,
    "verification_status" TEXT NOT NULL DEFAULT 'DECLARED',
    "observed_at" TIMESTAMPTZ(6) NOT NULL,
    "valid_from" TIMESTAMPTZ(6),
    "valid_to" TIMESTAMPTZ(6),
    "current_status" TEXT NOT NULL DEFAULT 'VALID',
    "ai_derived" BOOLEAN NOT NULL DEFAULT false,
    "content_hash" TEXT NOT NULL,
    "source_document_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Assertion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence"."AssertionEvent" (
    "id" UUID NOT NULL,
    "assertion_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "actor" TEXT NOT NULL,
    "source_event_id" TEXT,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssertionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence"."AssertionLink" (
    "id" UUID NOT NULL,
    "from_assertion_id" UUID NOT NULL,
    "to_assertion_id" UUID NOT NULL,
    "link_type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssertionLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence"."EvidenceArtifact" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "document_type" TEXT NOT NULL,
    "issuer" TEXT,
    "storage_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "retrieved_at" TIMESTAMPTZ(6) NOT NULL,
    "source_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenceArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence"."DocumentTypePolicy" (
    "document_type" TEXT NOT NULL,
    "globally_shareable" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentTypePolicy_pkey" PRIMARY KEY ("document_type")
);

-- CreateTable
CREATE TABLE "intelligence"."ArtifactSupport" (
    "assertion_id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArtifactSupport_pkey" PRIMARY KEY ("assertion_id","artifact_id")
);

-- CreateTable
CREATE TABLE "intelligence"."ResolvedProfileFact" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "fact_type" TEXT NOT NULL,
    "fact_key" TEXT NOT NULL DEFAULT '',
    "value" JSONB NOT NULL,
    "supporting_assertion_ids" UUID[],
    "resolved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResolvedProfileFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence"."IdentityConflict" (
    "id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "conflict_type" TEXT NOT NULL,
    "related_subject_ids" UUID[],
    "details" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "IdentityConflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence"."MergeSplitEvent" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "from_subject_id" UUID NOT NULL,
    "into_subject_id" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "moved" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MergeSplitEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence"."IntelligenceInbox" (
    "event_id" TEXT NOT NULL,
    "source_system_id" TEXT NOT NULL,
    "source_tenant_id" TEXT NOT NULL,
    "external_talent_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL,
    "response" JSONB NOT NULL,

    CONSTRAINT "IntelligenceInbox_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "intelligence"."IntelligenceQuarantine" (
    "id" UUID NOT NULL,
    "source_system_id" TEXT,
    "source_event_id" TEXT,
    "client_id" TEXT,
    "reason" TEXT NOT NULL,
    "issues" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntelligenceQuarantine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence"."IntelligenceOutbox" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_version" TEXT NOT NULL DEFAULT 'v1',
    "tenant_id" TEXT,
    "source" TEXT NOT NULL DEFAULT 'talent-intelligence',
    "subject_type" TEXT NOT NULL DEFAULT 'golden_talent',
    "subject_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "correlation_id" TEXT,
    "causation_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(6),
    "lease_expires_at" TIMESTAMPTZ(6),
    "publish_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_publish_error" TEXT,
    "published_at" TIMESTAMPTZ(6),
    "quarantined_at" TIMESTAMPTZ(6),

    CONSTRAINT "IntelligenceOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence"."ServiceClient" (
    "client_id" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "allowed_scopes" TEXT[],
    "source_system_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServiceClient_pkey" PRIMARY KEY ("client_id")
);

-- CreateIndex
CREATE INDEX "GoldenTalent_merged_into_id_idx" ON "intelligence"."GoldenTalent"("merged_into_id");

-- CreateIndex
CREATE INDEX "SubjectIdentifier_identifier_type_normalized_value_idx" ON "intelligence"."SubjectIdentifier"("identifier_type", "normalized_value");

-- CreateIndex
CREATE INDEX "SubjectIdentifier_subject_id_idx" ON "intelligence"."SubjectIdentifier"("subject_id");

-- CreateIndex
CREATE INDEX "SubjectIdentifier_source_reference_id_idx" ON "intelligence"."SubjectIdentifier"("source_reference_id");

-- CreateIndex
CREATE INDEX "ExternalTalentReference_subject_id_idx" ON "intelligence"."ExternalTalentReference"("subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalTalentReference_source_system_id_source_tenant_id_e_key" ON "intelligence"."ExternalTalentReference"("source_system_id", "source_tenant_id", "external_talent_id");

-- CreateIndex
CREATE INDEX "Assertion_subject_id_assertion_type_idx" ON "intelligence"."Assertion"("subject_id", "assertion_type");

-- CreateIndex
CREATE INDEX "Assertion_source_reference_id_content_hash_idx" ON "intelligence"."Assertion"("source_reference_id", "content_hash");

-- CreateIndex
CREATE INDEX "AssertionEvent_assertion_id_created_at_idx" ON "intelligence"."AssertionEvent"("assertion_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "AssertionLink_from_assertion_id_to_assertion_id_link_type_key" ON "intelligence"."AssertionLink"("from_assertion_id", "to_assertion_id", "link_type");

-- CreateIndex
CREATE INDEX "EvidenceArtifact_subject_id_idx" ON "intelligence"."EvidenceArtifact"("subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "ResolvedProfileFact_subject_id_fact_type_fact_key_key" ON "intelligence"."ResolvedProfileFact"("subject_id", "fact_type", "fact_key");

-- CreateIndex
CREATE INDEX "IdentityConflict_subject_id_status_idx" ON "intelligence"."IdentityConflict"("subject_id", "status");

-- CreateIndex
CREATE INDEX "MergeSplitEvent_from_subject_id_idx" ON "intelligence"."MergeSplitEvent"("from_subject_id");

-- CreateIndex
CREATE INDEX "MergeSplitEvent_into_subject_id_idx" ON "intelligence"."MergeSplitEvent"("into_subject_id");

-- CreateIndex
CREATE INDEX "IntelligenceQuarantine_received_at_idx" ON "intelligence"."IntelligenceQuarantine"("received_at");

-- CreateIndex
CREATE INDEX "IntelligenceOutbox_published_at_quarantined_at_created_at_idx" ON "intelligence"."IntelligenceOutbox"("published_at", "quarantined_at", "created_at");

-- AddForeignKey
ALTER TABLE "intelligence"."GoldenTalent" ADD CONSTRAINT "GoldenTalent_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "intelligence"."GoldenTalent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."SubjectIdentifier" ADD CONSTRAINT "SubjectIdentifier_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "intelligence"."GoldenTalent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."SubjectIdentifier" ADD CONSTRAINT "SubjectIdentifier_source_reference_id_fkey" FOREIGN KEY ("source_reference_id") REFERENCES "intelligence"."ExternalTalentReference"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."ExternalTalentReference" ADD CONSTRAINT "ExternalTalentReference_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "intelligence"."GoldenTalent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."Assertion" ADD CONSTRAINT "Assertion_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "intelligence"."GoldenTalent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."Assertion" ADD CONSTRAINT "Assertion_source_reference_id_fkey" FOREIGN KEY ("source_reference_id") REFERENCES "intelligence"."ExternalTalentReference"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."AssertionEvent" ADD CONSTRAINT "AssertionEvent_assertion_id_fkey" FOREIGN KEY ("assertion_id") REFERENCES "intelligence"."Assertion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."AssertionLink" ADD CONSTRAINT "AssertionLink_from_assertion_id_fkey" FOREIGN KEY ("from_assertion_id") REFERENCES "intelligence"."Assertion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."AssertionLink" ADD CONSTRAINT "AssertionLink_to_assertion_id_fkey" FOREIGN KEY ("to_assertion_id") REFERENCES "intelligence"."Assertion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."EvidenceArtifact" ADD CONSTRAINT "EvidenceArtifact_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "intelligence"."GoldenTalent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."EvidenceArtifact" ADD CONSTRAINT "EvidenceArtifact_document_type_fkey" FOREIGN KEY ("document_type") REFERENCES "intelligence"."DocumentTypePolicy"("document_type") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."ArtifactSupport" ADD CONSTRAINT "ArtifactSupport_assertion_id_fkey" FOREIGN KEY ("assertion_id") REFERENCES "intelligence"."Assertion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."ArtifactSupport" ADD CONSTRAINT "ArtifactSupport_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "intelligence"."EvidenceArtifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."ResolvedProfileFact" ADD CONSTRAINT "ResolvedProfileFact_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "intelligence"."GoldenTalent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."IdentityConflict" ADD CONSTRAINT "IdentityConflict_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "intelligence"."GoldenTalent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- Closed status vocabularies (fixed sets) as CHECK constraints.
-- ============================================================================
ALTER TABLE "intelligence"."GoldenTalent"
  ADD CONSTRAINT "GoldenTalent_resolution_status_check" CHECK ("resolution_status" IN ('ACTIVE', 'PROVISIONAL', 'MERGED')),
  ADD CONSTRAINT "GoldenTalent_access_state_check" CHECK ("access_state" IN ('ACTIVE', 'AUDIT_RETAINED')),
  ADD CONSTRAINT "GoldenTalent_merged_into_check" CHECK (("resolution_status" = 'MERGED') = ("merged_into_id" IS NOT NULL)),
  ADD CONSTRAINT "GoldenTalent_not_self_merged_check" CHECK ("merged_into_id" IS NULL OR "merged_into_id" <> "id");

ALTER TABLE "intelligence"."SubjectIdentifier"
  ADD CONSTRAINT "SubjectIdentifier_identifier_type_check" CHECK ("identifier_type" IN ('EMAIL', 'PHONE', 'GOV_ID')),
  ADD CONSTRAINT "SubjectIdentifier_verification_status_check" CHECK ("verification_status" IN ('UNVERIFIED', 'VERIFIED', 'REVOKED')),
  ADD CONSTRAINT "SubjectIdentifier_status_check" CHECK ("status" IN ('ACTIVE', 'SUPERSEDED')),
  -- ADR-0036 Section 5.6: a government identifier is stored ONLY as a keyed
  -- HMAC-SHA256 token (64 lowercase hex), never as the raw value.
  ADD CONSTRAINT "SubjectIdentifier_gov_id_token_only_check" CHECK ("identifier_type" <> 'GOV_ID' OR "normalized_value" ~ '^[a-f0-9]{64}$');

ALTER TABLE "intelligence"."ExternalTalentReference"
  ADD CONSTRAINT "ExternalTalentReference_status_check" CHECK ("status" IN ('ACTIVE', 'ERASED', 'DETACHED'));

ALTER TABLE "intelligence"."Assertion"
  ADD CONSTRAINT "Assertion_admission_class_check" CHECK ("admission_class" IN ('A', 'B')),
  ADD CONSTRAINT "Assertion_source_kind_check" CHECK ("source_kind" IN ('RECRUITER', 'RESUME_DERIVED', 'TALENT_SELF', 'TI_ACQUIRED', 'VERIFICATION')),
  ADD CONSTRAINT "Assertion_verification_status_check" CHECK ("verification_status" IN ('DECLARED', 'DOCUMENT_SUPPORTED', 'VERIFIED')),
  ADD CONSTRAINT "Assertion_current_status_check" CHECK ("current_status" IN ('VALID', 'STALE', 'CONTRADICTED', 'REVOKED', 'SUPERSEDED', 'DISPUTED', 'WITHDRAWN')),
  ADD CONSTRAINT "Assertion_source_document_hash_check" CHECK ("source_document_hash" IS NULL OR "source_document_hash" ~ '^[a-f0-9]{64}$');

ALTER TABLE "intelligence"."AssertionLink"
  ADD CONSTRAINT "AssertionLink_link_type_check" CHECK ("link_type" IN ('CORROBORATES', 'CONTRADICTS', 'SUPERSEDES')),
  ADD CONSTRAINT "AssertionLink_not_self_check" CHECK ("from_assertion_id" <> "to_assertion_id");

ALTER TABLE "intelligence"."IdentityConflict"
  ADD CONSTRAINT "IdentityConflict_conflict_type_check" CHECK ("conflict_type" IN ('IDENTITY_ATTRIBUTE_CONFLICT', 'ANCHOR_CONTRADICTION', 'REFERENCE_IDENTITY_MUTATION')),
  ADD CONSTRAINT "IdentityConflict_status_check" CHECK ("status" IN ('OPEN', 'RESOLVED'));

ALTER TABLE "intelligence"."MergeSplitEvent"
  ADD CONSTRAINT "MergeSplitEvent_kind_check" CHECK ("kind" IN ('MERGE', 'SPLIT')),
  ADD CONSTRAINT "MergeSplitEvent_distinct_subjects_check" CHECK ("from_subject_id" <> "into_subject_id");

ALTER TABLE "intelligence"."IntelligenceInbox"
  ADD CONSTRAINT "IntelligenceInbox_kind_check" CHECK ("kind" IN ('TALENT_SNAPSHOT', 'TALENT_ERASED'));

ALTER TABLE "intelligence"."IntelligenceQuarantine"
  ADD CONSTRAINT "IntelligenceQuarantine_reason_check" CHECK ("reason" IN ('DOCUMENT_REJECTED', 'CLASS_C_REJECTED', 'INVALID_REQUEST'));

-- ============================================================================
-- ADR-0036 Section 5.2 — a VERIFIED, ACTIVE identifier binds to AT MOST ONE row
-- (therefore one subject). Unverified / superseded rows are unconstrained.
-- ============================================================================
CREATE UNIQUE INDEX "SubjectIdentifier_verified_active_unique"
  ON "intelligence"."SubjectIdentifier" ("identifier_type", "normalized_value")
  WHERE "verification_status" = 'VERIFIED' AND "status" = 'ACTIVE';

-- Ingest dedupe backstop: one LIVE assertion per (source reference, content hash).
CREATE UNIQUE INDEX "Assertion_reference_content_live_unique"
  ON "intelligence"."Assertion" ("source_reference_id", "content_hash")
  WHERE "source_reference_id" IS NOT NULL AND "current_status" NOT IN ('SUPERSEDED', 'WITHDRAWN', 'REVOKED');

-- Outbox claim scan (unpublished, not quarantined).
CREATE INDEX "IntelligenceOutbox_pending_idx"
  ON "intelligence"."IntelligenceOutbox" ("created_at")
  WHERE "published_at" IS NULL AND "quarantined_at" IS NULL;

-- ============================================================================
-- Assertion immutability. Only current_status may change. A merge or split
-- re-points subject_id — allowed ONLY when the transaction set
-- intelligence.repoint = 'on' (set_config is_local, merge/split service only).
-- Every other column is frozen, including source_reference_id.
-- ============================================================================
CREATE OR REPLACE FUNCTION "intelligence".assertion_content_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.assertion_type IS DISTINCT FROM OLD.assertion_type
     OR NEW.admission_class IS DISTINCT FROM OLD.admission_class
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.source_reference_id IS DISTINCT FROM OLD.source_reference_id
     OR NEW.source_system_id IS DISTINCT FROM OLD.source_system_id
     OR NEW.source_tenant_id IS DISTINCT FROM OLD.source_tenant_id
     OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
     OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
     OR NEW.verification_status IS DISTINCT FROM OLD.verification_status
     OR NEW.observed_at IS DISTINCT FROM OLD.observed_at
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.valid_to IS DISTINCT FROM OLD.valid_to
     OR NEW.ai_derived IS DISTINCT FROM OLD.ai_derived
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.source_document_hash IS DISTINCT FROM OLD.source_document_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Assertion content is immutable, only current_status may change';
  END IF;
  IF NEW.subject_id IS DISTINCT FROM OLD.subject_id
     AND coalesce(current_setting('intelligence.repoint', true), '') <> 'on'
  THEN
    RAISE EXCEPTION 'Assertion subject_id changes only through a merge or split';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assertion_content_immutable
  BEFORE UPDATE ON "intelligence"."Assertion"
  FOR EACH ROW EXECUTE FUNCTION "intelligence".assertion_content_immutable();

-- Append-only logs: AssertionEvent, AssertionLink, MergeSplitEvent never change.
CREATE OR REPLACE FUNCTION "intelligence".reject_update_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only, UPDATE rejected', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assertion_event_no_update
  BEFORE UPDATE ON "intelligence"."AssertionEvent"
  FOR EACH ROW EXECUTE FUNCTION "intelligence".reject_update_append_only();

CREATE TRIGGER assertion_link_no_update
  BEFORE UPDATE ON "intelligence"."AssertionLink"
  FOR EACH ROW EXECUTE FUNCTION "intelligence".reject_update_append_only();

CREATE TRIGGER merge_split_event_no_update
  BEFORE UPDATE ON "intelligence"."MergeSplitEvent"
  FOR EACH ROW EXECUTE FUNCTION "intelligence".reject_update_append_only();

-- Evidence is never deleted (Addendum A1): no DELETE on the evidence tables.
CREATE OR REPLACE FUNCTION "intelligence".reject_evidence_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is retained evidence, DELETE rejected', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assertion_no_delete
  BEFORE DELETE ON "intelligence"."Assertion"
  FOR EACH ROW EXECUTE FUNCTION "intelligence".reject_evidence_delete();

CREATE TRIGGER assertion_event_no_delete
  BEFORE DELETE ON "intelligence"."AssertionEvent"
  FOR EACH ROW EXECUTE FUNCTION "intelligence".reject_evidence_delete();

CREATE TRIGGER assertion_link_no_delete
  BEFORE DELETE ON "intelligence"."AssertionLink"
  FOR EACH ROW EXECUTE FUNCTION "intelligence".reject_evidence_delete();

CREATE TRIGGER merge_split_event_no_delete
  BEFORE DELETE ON "intelligence"."MergeSplitEvent"
  FOR EACH ROW EXECUTE FUNCTION "intelligence".reject_evidence_delete();

CREATE TRIGGER evidence_artifact_no_delete
  BEFORE DELETE ON "intelligence"."EvidenceArtifact"
  FOR EACH ROW EXECUTE FUNCTION "intelligence".reject_evidence_delete();

INSERT INTO "intelligence"."ServiceInfo" ("key", "value")
VALUES ('golden_model', 'ATI-SEP-1-T1')
ON CONFLICT ("key") DO NOTHING;
