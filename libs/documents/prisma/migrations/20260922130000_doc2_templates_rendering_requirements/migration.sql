-- DOC-2 — Templates + Rendering foundations + Requirements + Packets.
-- Governing directive Aramo-DOC-2-Templates-Rendering-Requirements-Slice-Directive-v1_0-LOCKED.
-- Additive to the DOC-1a documents schema. Adds 7 tables (DocumentTemplate,
-- TemplateVersion, TemplateFieldDefinition, TemplateAsset, DocumentRequirement,
-- DocumentPacket, DocumentPacketItem), the FKs onto DOC-1a's already-present
-- template_version_id UUID columns (R-2-2), and the TemplateVersion
-- immutability trigger (R-2-3, dollar-quoted, IS DISTINCT FROM to avoid the
-- NULL-comparison gap). splitDdl-safe: no semicolons inside comment lines.

-- CreateTable DocumentTemplate
CREATE TABLE "documents"."DocumentTemplate" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "document_type_id" UUID NOT NULL,
  "client_id" UUID,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "template_kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "current_version_id" UUID,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "DocumentTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentTemplate_kind_check" CHECK ("template_kind" IN ('GENERATED', 'UPLOADED_PDF', 'HYBRID')),
  CONSTRAINT "DocumentTemplate_status_check" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'RETIRED'))
);
CREATE INDEX "DocumentTemplate_tenant_id_idx" ON "documents"."DocumentTemplate" ("tenant_id");
CREATE INDEX "DocumentTemplate_tenant_id_document_type_id_idx" ON "documents"."DocumentTemplate" ("tenant_id", "document_type_id");

-- CreateTable TemplateVersion
CREATE TABLE "documents"."TemplateVersion" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "template_id" UUID NOT NULL,
  "version_number" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "source_artifact_id" UUID,
  "render_schema_version" TEXT NOT NULL,
  "field_schema" JSONB,
  "binding_schema" JSONB,
  "effective_from" TIMESTAMPTZ,
  "effective_until" TIMESTAMPTZ,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "activated_at" TIMESTAMPTZ,
  "retired_at" TIMESTAMPTZ,
  CONSTRAINT "TemplateVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TemplateVersion_status_check" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'RETIRED'))
);
CREATE UNIQUE INDEX "TemplateVersion_template_id_version_number_key" ON "documents"."TemplateVersion" ("template_id", "version_number");
CREATE INDEX "TemplateVersion_tenant_id_idx" ON "documents"."TemplateVersion" ("tenant_id");
CREATE INDEX "TemplateVersion_tenant_id_template_id_idx" ON "documents"."TemplateVersion" ("tenant_id", "template_id");

-- CreateTable TemplateFieldDefinition — the canonical field model (NOT AcroForm).
CREATE TABLE "documents"."TemplateFieldDefinition" (
  "id" UUID NOT NULL,
  "template_version_id" UUID NOT NULL,
  "field_key" TEXT NOT NULL,
  "field_type" TEXT NOT NULL,
  "binding_key" TEXT,
  "required" BOOLEAN NOT NULL DEFAULT false,
  "page_number" INTEGER,
  "x" DOUBLE PRECISION,
  "y" DOUBLE PRECISION,
  "width" DOUBLE PRECISION,
  "height" DOUBLE PRECISION,
  "format_rule" TEXT,
  "signer_role" TEXT,
  "ordinal" INTEGER NOT NULL,
  CONSTRAINT "TemplateFieldDefinition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TemplateFieldDefinition_type_check" CHECK ("field_type" IN ('TEXT', 'MULTILINE_TEXT', 'DATE', 'NUMBER', 'CURRENCY', 'CHECKBOX', 'IMAGE', 'SIGNATURE', 'INITIALS', 'SIGN_DATE', 'SIGNER_NAME', 'SIGNER_EMAIL'))
);
CREATE UNIQUE INDEX "TemplateFieldDefinition_version_field_key" ON "documents"."TemplateFieldDefinition" ("template_version_id", "field_key");
CREATE INDEX "TemplateFieldDefinition_template_version_id_idx" ON "documents"."TemplateFieldDefinition" ("template_version_id");

-- CreateTable TemplateAsset — controlled, content-hashed render inputs.
CREATE TABLE "documents"."TemplateAsset" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "asset_kind" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "storage_provider" TEXT NOT NULL,
  "storage_locator" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "TemplateAsset_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TemplateAsset_kind_check" CHECK ("asset_kind" IN ('FONT', 'IMAGE', 'LOGO'))
);
CREATE INDEX "TemplateAsset_tenant_id_idx" ON "documents"."TemplateAsset" ("tenant_id");
CREATE INDEX "TemplateAsset_tenant_id_asset_kind_idx" ON "documents"."TemplateAsset" ("tenant_id", "asset_kind");

-- CreateTable DocumentRequirement — the generic requirement bridge (R12).
CREATE TABLE "documents"."DocumentRequirement" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "document_type_id" UUID NOT NULL,
  "resource_type" TEXT NOT NULL,
  "resource_id" UUID NOT NULL,
  "relationship" TEXT,
  "status" TEXT NOT NULL,
  "satisfied_by_document_id" UUID,
  "waived_by" UUID,
  "waived_reason" TEXT,
  "waived_at" TIMESTAMPTZ,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "DocumentRequirement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentRequirement_resource_type_check" CHECK ("resource_type" IN ('TALENT', 'REQUISITION', 'COMPANY', 'SUBMITTAL', 'OFFER', 'PLACEMENT', 'PURCHASE_ORDER', 'TENANT_ORGANIZATION', 'CONTACT')),
  CONSTRAINT "DocumentRequirement_relationship_check" CHECK ("relationship" IS NULL OR "relationship" IN ('SUBJECT', 'REGARDING', 'CLIENT', 'SUPPORTS', 'OWNER', 'ISSUER', 'COUNTERPARTY')),
  CONSTRAINT "DocumentRequirement_status_check" CHECK ("status" IN ('UNSATISFIED', 'SATISFIED', 'WAIVED'))
);
CREATE INDEX "DocumentRequirement_tenant_id_idx" ON "documents"."DocumentRequirement" ("tenant_id");
CREATE INDEX "DocumentRequirement_tenant_resource_idx" ON "documents"."DocumentRequirement" ("tenant_id", "resource_type", "resource_id");
CREATE INDEX "DocumentRequirement_tenant_id_document_type_id_idx" ON "documents"."DocumentRequirement" ("tenant_id", "document_type_id");

-- CreateTable DocumentPacket — generic grouping of Documents.
CREATE TABLE "documents"."DocumentPacket" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "packet_type" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "completed_at" TIMESTAMPTZ,
  CONSTRAINT "DocumentPacket_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DocumentPacket_status_check" CHECK ("status" IN ('OPEN', 'COMPLETED', 'CANCELLED'))
);
CREATE INDEX "DocumentPacket_tenant_id_idx" ON "documents"."DocumentPacket" ("tenant_id");
CREATE INDEX "DocumentPacket_tenant_id_packet_type_idx" ON "documents"."DocumentPacket" ("tenant_id", "packet_type");

-- CreateTable DocumentPacketItem — a Document's membership in a packet.
CREATE TABLE "documents"."DocumentPacketItem" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "packet_id" UUID NOT NULL,
  "document_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "DocumentPacketItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DocumentPacketItem_packet_document_key" ON "documents"."DocumentPacketItem" ("packet_id", "document_id");
CREATE INDEX "DocumentPacketItem_tenant_id_idx" ON "documents"."DocumentPacketItem" ("tenant_id");
CREATE INDEX "DocumentPacketItem_packet_id_idx" ON "documents"."DocumentPacketItem" ("packet_id");

-- Intra-new-cluster + cross-to-DOC-1a foreign keys (all same-schema, real FKs).
ALTER TABLE "documents"."DocumentTemplate"
  ADD CONSTRAINT "DocumentTemplate_document_type_id_fkey"
  FOREIGN KEY ("document_type_id") REFERENCES "documents"."DocumentType" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents"."TemplateVersion"
  ADD CONSTRAINT "TemplateVersion_template_id_fkey"
  FOREIGN KEY ("template_id") REFERENCES "documents"."DocumentTemplate" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents"."TemplateVersion"
  ADD CONSTRAINT "TemplateVersion_source_artifact_id_fkey"
  FOREIGN KEY ("source_artifact_id") REFERENCES "documents"."DocumentArtifact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents"."DocumentTemplate"
  ADD CONSTRAINT "DocumentTemplate_current_version_id_fkey"
  FOREIGN KEY ("current_version_id") REFERENCES "documents"."TemplateVersion" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "documents"."TemplateFieldDefinition"
  ADD CONSTRAINT "TemplateFieldDefinition_template_version_id_fkey"
  FOREIGN KEY ("template_version_id") REFERENCES "documents"."TemplateVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "documents"."DocumentRequirement"
  ADD CONSTRAINT "DocumentRequirement_document_type_id_fkey"
  FOREIGN KEY ("document_type_id") REFERENCES "documents"."DocumentType" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents"."DocumentRequirement"
  ADD CONSTRAINT "DocumentRequirement_satisfied_by_document_id_fkey"
  FOREIGN KEY ("satisfied_by_document_id") REFERENCES "documents"."Document" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "documents"."DocumentPacketItem"
  ADD CONSTRAINT "DocumentPacketItem_packet_id_fkey"
  FOREIGN KEY ("packet_id") REFERENCES "documents"."DocumentPacket" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "documents"."DocumentPacketItem"
  ADD CONSTRAINT "DocumentPacketItem_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "documents"."Document" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- R-2-2 — FK the already-present (DOC-1a) template_version_id UUID columns onto
-- the new TemplateVersion. Columns/nullability unchanged (ON DELETE RESTRICT:
-- a version referenced by a generated document is immutable history, Invariant 5).
ALTER TABLE "documents"."Document"
  ADD CONSTRAINT "Document_template_version_id_fkey"
  FOREIGN KEY ("template_version_id") REFERENCES "documents"."TemplateVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents"."DocumentRevision"
  ADD CONSTRAINT "DocumentRevision_template_version_id_fkey"
  FOREIGN KEY ("template_version_id") REFERENCES "documents"."TemplateVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- R-2-3 — TemplateVersion immutability after activation. Once status = 'ACTIVE',
-- content-bearing fields are frozen and status may only transition to 'RETIRED'.
-- IS DISTINCT FROM handles NULLable content (field_schema/binding_schema) without
-- the NULL = NULL gap. App-surface guard rides atop this (defence in depth).
CREATE OR REPLACE FUNCTION documents.enforce_template_version_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."status" = 'ACTIVE' THEN
    IF NEW."field_schema" IS DISTINCT FROM OLD."field_schema"
       OR NEW."binding_schema" IS DISTINCT FROM OLD."binding_schema"
       OR NEW."render_schema_version" IS DISTINCT FROM OLD."render_schema_version"
       OR NEW."source_artifact_id" IS DISTINCT FROM OLD."source_artifact_id"
       OR NEW."version_number" IS DISTINCT FROM OLD."version_number" THEN
      RAISE EXCEPTION 'TemplateVersion is immutable after activation (DOC-2 R-2-3): content fields cannot change once ACTIVE';
    END IF;
    IF NEW."status" NOT IN ('ACTIVE', 'RETIRED') THEN
      RAISE EXCEPTION 'TemplateVersion ACTIVE may only transition to RETIRED (DOC-2 R-2-3), got %', NEW."status";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER template_version_immutability
  BEFORE UPDATE ON "documents"."TemplateVersion"
  FOR EACH ROW EXECUTE FUNCTION documents.enforce_template_version_immutability();
