-- DOC-4 (R-4-6) — transient execution-certificate holding until Documents write-back.
CREATE TABLE "esign"."ExecutionCertificate" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "envelope_id" UUID NOT NULL,
  "certificate_sha256" TEXT NOT NULL,
  "byte_size" INTEGER NOT NULL,
  "certificate_bytes" BYTEA NOT NULL,
  "produced_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "written_back_at" TIMESTAMPTZ,
  CONSTRAINT "ExecutionCertificate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExecutionCertificate_envelope_id_key" ON "esign"."ExecutionCertificate" ("envelope_id");
CREATE INDEX "ExecutionCertificate_tenant_id_idx" ON "esign"."ExecutionCertificate" ("tenant_id");
