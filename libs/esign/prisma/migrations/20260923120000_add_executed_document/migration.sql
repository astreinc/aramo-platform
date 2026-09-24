-- DOC-4 (R-4-3) — transient executed-document holding until Documents write-back.
CREATE TABLE "esign"."ExecutedDocument" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "envelope_id" UUID NOT NULL,
  "envelope_document_id" UUID NOT NULL,
  "source_sha256" TEXT NOT NULL,
  "executed_sha256" TEXT NOT NULL,
  "byte_size" INTEGER NOT NULL,
  "executed_bytes" BYTEA NOT NULL,
  "produced_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "written_back_at" TIMESTAMPTZ,
  CONSTRAINT "ExecutedDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExecutedDocument_envelope_document_id_key" ON "esign"."ExecutedDocument" ("envelope_document_id");
CREATE INDEX "ExecutedDocument_tenant_id_idx" ON "esign"."ExecutedDocument" ("tenant_id");
CREATE INDEX "ExecutedDocument_envelope_id_idx" ON "esign"."ExecutedDocument" ("envelope_id");
