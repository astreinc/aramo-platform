-- DOC-1a — canonical Documents domain (greenfield).
-- Governing directive Aramo-DOC-1a-Documents-Core-Slice-Directive-v1_0-LOCKED.
-- Schema-per-module. DocumentAssociation is the ONLY polymorphic table
-- (controlled vocab + unique tuple). DocumentArtifact belongs to a
-- DocumentRevision, and its denormalized document_id is invariant with the
-- revision parent (trigger below). DocumentEvent is append-only (unconditional
-- trigger, RN-1 precedent, no NULL-comparison gap).
-- splitDdl-safe: no semicolons inside comment lines, trigger bodies dollar-quoted.

CREATE SCHEMA IF NOT EXISTS "documents";

-- CreateTable DocumentType
CREATE TABLE "documents"."DocumentType" (
  "id" UUID NOT NULL,
  "tenant_id" UUID,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "scope" TEXT NOT NULL,
  "execution_mode_default" TEXT NOT NULL,
  "retention_class" TEXT NOT NULL,
  "system_defined" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "DocumentType_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentType_scope_check" CHECK ("scope" IN ('SYSTEM', 'TENANT', 'CLIENT')),
  CONSTRAINT "DocumentType_execmode_check" CHECK ("execution_mode_default" IN ('NO_SIGNATURE', 'ACKNOWLEDGEMENT', 'SINGLE_SIGNATURE', 'MULTI_SIGNATURE'))
);
CREATE UNIQUE INDEX "DocumentType_tenant_id_key_key" ON "documents"."DocumentType" ("tenant_id", "key");
CREATE INDEX "DocumentType_tenant_id_idx" ON "documents"."DocumentType" ("tenant_id");

-- CreateTable Document
CREATE TABLE "documents"."Document" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "document_type_id" UUID NOT NULL,
  "template_version_id" UUID,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "execution_mode" TEXT NOT NULL,
  "current_revision_id" UUID,
  "source_kind" TEXT NOT NULL,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "prepared_at" TIMESTAMPTZ,
  "execution_started_at" TIMESTAMPTZ,
  "executed_at" TIMESTAMPTZ,
  "voided_at" TIMESTAMPTZ,
  "superseded_at" TIMESTAMPTZ,
  CONSTRAINT "Document_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Document_status_check" CHECK ("status" IN ('DRAFT', 'PREPARED', 'EXECUTION_PENDING', 'EXECUTED', 'VOIDED', 'EXPIRED', 'ARCHIVED')),
  CONSTRAINT "Document_execmode_check" CHECK ("execution_mode" IN ('NO_SIGNATURE', 'ACKNOWLEDGEMENT', 'SINGLE_SIGNATURE', 'MULTI_SIGNATURE')),
  CONSTRAINT "Document_source_kind_check" CHECK ("source_kind" IN ('TEMPLATE_GENERATED', 'UPLOADED', 'EXTERNAL_IMPORT'))
);
CREATE INDEX "Document_tenant_id_idx" ON "documents"."Document" ("tenant_id");
CREATE INDEX "Document_tenant_id_document_type_id_idx" ON "documents"."Document" ("tenant_id", "document_type_id");

-- CreateTable DocumentRevision
CREATE TABLE "documents"."DocumentRevision" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "revision_number" INTEGER NOT NULL,
  "template_version_id" UUID,
  "render_manifest" JSONB,
  "source_artifact_id" UUID,
  "prepared_artifact_id" UUID,
  "content_sha256" TEXT,
  "mime_type" TEXT,
  "byte_size" INTEGER,
  "status" TEXT NOT NULL,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "frozen_at" TIMESTAMPTZ,
  CONSTRAINT "DocumentRevision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DocumentRevision_document_id_revision_number_key" ON "documents"."DocumentRevision" ("document_id", "revision_number");
CREATE INDEX "DocumentRevision_tenant_id_idx" ON "documents"."DocumentRevision" ("tenant_id");
CREATE INDEX "DocumentRevision_tenant_id_document_id_idx" ON "documents"."DocumentRevision" ("tenant_id", "document_id");

-- CreateTable DocumentArtifact
CREATE TABLE "documents"."DocumentArtifact" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "revision_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "artifact_role" TEXT NOT NULL,
  "storage_profile_id" UUID,
  "storage_provider" TEXT NOT NULL,
  "storage_locator" TEXT NOT NULL,
  "provider_version_id" TEXT,
  "mime_type" TEXT NOT NULL,
  "byte_size" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "immutability_state" TEXT NOT NULL,
  "retention_class" TEXT NOT NULL,
  "retain_until" TIMESTAMPTZ,
  "legal_hold" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_by" UUID NOT NULL,
  CONSTRAINT "DocumentArtifact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentArtifact_role_check" CHECK ("artifact_role" IN ('TEMPLATE_SOURCE', 'SOURCE_UPLOAD', 'RENDERED_UNSIGNED', 'EXECUTED', 'EXECUTION_CERTIFICATE', 'PREVIEW', 'ATTACHMENT')),
  CONSTRAINT "DocumentArtifact_immutability_check" CHECK ("immutability_state" IN ('MUTABLE', 'FROZEN'))
);
CREATE INDEX "DocumentArtifact_tenant_id_idx" ON "documents"."DocumentArtifact" ("tenant_id");
CREATE INDEX "DocumentArtifact_tenant_id_revision_id_idx" ON "documents"."DocumentArtifact" ("tenant_id", "revision_id");
CREATE INDEX "DocumentArtifact_tenant_id_document_id_idx" ON "documents"."DocumentArtifact" ("tenant_id", "document_id");

-- CreateTable DocumentAssociation — the ONLY polymorphic table.
CREATE TABLE "documents"."DocumentAssociation" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "resource_type" TEXT NOT NULL,
  "resource_id" UUID NOT NULL,
  "relationship" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_by" UUID NOT NULL,
  CONSTRAINT "DocumentAssociation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentAssociation_resource_type_check" CHECK ("resource_type" IN ('TALENT', 'REQUISITION', 'COMPANY', 'SUBMITTAL', 'OFFER', 'PLACEMENT', 'PURCHASE_ORDER', 'TENANT_ORGANIZATION', 'CONTACT')),
  CONSTRAINT "DocumentAssociation_relationship_check" CHECK ("relationship" IN ('SUBJECT', 'REGARDING', 'CLIENT', 'SUPPORTS', 'OWNER', 'ISSUER', 'COUNTERPARTY'))
);
CREATE UNIQUE INDEX "DocumentAssociation_unique_tuple" ON "documents"."DocumentAssociation" ("tenant_id", "document_id", "resource_type", "resource_id", "relationship");
CREATE INDEX "DocumentAssociation_tenant_id_idx" ON "documents"."DocumentAssociation" ("tenant_id");
CREATE INDEX "DocumentAssociation_tenant_resource_idx" ON "documents"."DocumentAssociation" ("tenant_id", "resource_type", "resource_id");

-- CreateTable DocumentEvent — append-only.
CREATE TABLE "documents"."DocumentEvent" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "revision_id" UUID,
  "event_type" TEXT NOT NULL,
  "actor_type" TEXT NOT NULL,
  "actor_id" UUID,
  "correlation_id" UUID,
  "request_id" TEXT,
  "payload" JSONB,
  "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "DocumentEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentEvent_actor_type_check" CHECK ("actor_type" IN ('USER', 'SYSTEM'))
);
CREATE INDEX "DocumentEvent_tenant_document_occurred_idx" ON "documents"."DocumentEvent" ("tenant_id", "document_id", "occurred_at");
CREATE INDEX "DocumentEvent_tenant_occurred_idx" ON "documents"."DocumentEvent" ("tenant_id", "occurred_at");

-- CreateTable OutboxEvent
CREATE TABLE "documents"."OutboxEvent" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "event_type" TEXT NOT NULL,
  "event_payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "published_at" TIMESTAMPTZ,
  CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OutboxEvent_published_at_idx" ON "documents"."OutboxEvent" ("published_at");

-- CreateTable IdempotencyKey
CREATE TABLE "documents"."IdempotencyKey" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "response_status" INTEGER,
  "response_body" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IdempotencyKey_tenant_id_key_key" ON "documents"."IdempotencyKey" ("tenant_id", "key");

-- Intra-domain foreign keys (real, same-schema — D2.1).
ALTER TABLE "documents"."Document"
  ADD CONSTRAINT "Document_document_type_id_fkey"
  FOREIGN KEY ("document_type_id") REFERENCES "documents"."DocumentType" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents"."DocumentRevision"
  ADD CONSTRAINT "DocumentRevision_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "documents"."Document" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents"."Document"
  ADD CONSTRAINT "Document_current_revision_id_fkey"
  FOREIGN KEY ("current_revision_id") REFERENCES "documents"."DocumentRevision" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "documents"."DocumentArtifact"
  ADD CONSTRAINT "DocumentArtifact_revision_id_fkey"
  FOREIGN KEY ("revision_id") REFERENCES "documents"."DocumentRevision" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents"."DocumentAssociation"
  ADD CONSTRAINT "DocumentAssociation_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "documents"."Document" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents"."DocumentEvent"
  ADD CONSTRAINT "DocumentEvent_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "documents"."Document" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DocumentEvent append-only immutability (DB-enforced, unconditional, no
-- OLD/NEW comparison so there is no NULL-comparison gap — RN-1 precedent).
CREATE OR REPLACE FUNCTION documents.reject_document_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'DocumentEvent is append-only (DOC-1a): UPDATE and DELETE are rejected';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_event_append_only
  BEFORE UPDATE OR DELETE ON "documents"."DocumentEvent"
  FOR EACH ROW EXECUTE FUNCTION documents.reject_document_event_mutation();

-- DocumentArtifact denormalized document_id MUST equal the revision parent's
-- document_id (D2.2 invariant — an artifact never floats between revisions).
CREATE OR REPLACE FUNCTION documents.enforce_artifact_document_invariant()
RETURNS TRIGGER AS $$
DECLARE
  parent_document_id UUID;
BEGIN
  SELECT r."document_id" INTO parent_document_id
  FROM "documents"."DocumentRevision" r
  WHERE r."id" = NEW."revision_id";
  IF parent_document_id IS DISTINCT FROM NEW."document_id" THEN
    RAISE EXCEPTION 'DocumentArtifact.document_id (%) must equal revision parent document_id (%) (DOC-1a D2.2)', NEW."document_id", parent_document_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_artifact_document_invariant
  BEFORE INSERT OR UPDATE ON "documents"."DocumentArtifact"
  FOR EACH ROW EXECUTE FUNCTION documents.enforce_artifact_document_invariant();
