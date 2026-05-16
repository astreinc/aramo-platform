-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "ingestion";

-- CreateTable
CREATE TABLE "ingestion"."RawPayloadReference" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "storage_ref" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "captured_at" TIMESTAMPTZ NOT NULL,
    "verified_email" TEXT,
    "profile_url" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "RawPayloadReference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RawPayloadReference_tenant_id_verified_email_idx" ON "ingestion"."RawPayloadReference"("tenant_id", "verified_email");

-- CreateIndex
CREATE INDEX "RawPayloadReference_tenant_id_profile_url_idx" ON "ingestion"."RawPayloadReference"("tenant_id", "profile_url");

-- CreateIndex
CREATE UNIQUE INDEX "RawPayloadReference_tenant_id_sha256_key" ON "ingestion"."RawPayloadReference"("tenant_id", "sha256");

