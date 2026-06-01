-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "entitlement";

-- CreateEnum
CREATE TYPE "entitlement"."Capability" AS ENUM ('core', 'ats', 'portal', 'sourcing');

-- CreateTable
CREATE TABLE "entitlement"."TenantEntitlement" (
    "tenant_id" UUID NOT NULL,
    "capability" "entitlement"."Capability" NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantEntitlement_pkey" PRIMARY KEY ("tenant_id", "capability")
);

-- CreateIndex
CREATE INDEX "TenantEntitlement_tenant_id_idx" ON "entitlement"."TenantEntitlement"("tenant_id");

-- ============================================================================
-- Default-posture seed (PR-A1b Ruling 4).
-- Grants core / ats / portal to the bootstrap seeded tenant
-- (identity.SEED_IDS.tenant = 01900000-0000-7000-8000-000000000001).
-- `sourcing` is deliberately absent (Ruling 3 — Phase B). The INSERT is
-- idempotent via ON CONFLICT DO NOTHING so re-running the migration on
-- an already-seeded database is a no-op.
--
-- Additive: existing tenants gain capability rows but no other behavior
-- changes for already-provisioned data. Future tenants (post-A1b)
-- acquire entitlements via the future tenant-provisioning pathway
-- (Phase B); this migration only seeds the bootstrap tenant.
-- ============================================================================
INSERT INTO "entitlement"."TenantEntitlement" ("tenant_id", "capability")
VALUES
    ('01900000-0000-7000-8000-000000000001'::uuid, 'core'),
    ('01900000-0000-7000-8000-000000000001'::uuid, 'ats'),
    ('01900000-0000-7000-8000-000000000001'::uuid, 'portal')
ON CONFLICT ("tenant_id", "capability") DO NOTHING;
