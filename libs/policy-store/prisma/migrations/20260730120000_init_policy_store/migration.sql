-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "policy_store";

-- CreateTable
CREATE TABLE "policy_store"."StoredPolicyVersion" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "package_name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "checksum" TEXT NOT NULL,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "effective_to" TIMESTAMPTZ(6),
    "published_by" UUID NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredPolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoredPolicyVersion_tenant_id_package_name_version_key" ON "policy_store"."StoredPolicyVersion"("tenant_id", "package_name", "version");

-- CreateIndex
CREATE INDEX "StoredPolicyVersion_tenant_id_package_name_effective_from_idx" ON "policy_store"."StoredPolicyVersion"("tenant_id", "package_name", "effective_from");
