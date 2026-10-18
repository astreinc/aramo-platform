-- Aramo-E-Sign-Multi-Provider-Plan-Entitlements-Usage-Directive-v1_0-LOCKED §B/§C
-- Plan catalog, tenant subscriptions and the transactional allowance ledger.
-- Additive only: no existing table is touched and no tenant is subscribed here.

CREATE SCHEMA IF NOT EXISTS "subscription";

CREATE TABLE "subscription"."Plan" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Plan_key_key" ON "subscription"."Plan"("key");

CREATE TABLE "subscription"."PlanAllowance" (
    "plan_id" UUID NOT NULL,
    "allowance_key" TEXT NOT NULL,
    "included_quantity" INTEGER NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'MONTHLY',
    CONSTRAINT "PlanAllowance_pkey" PRIMARY KEY ("plan_id", "allowance_key"),
    CONSTRAINT "PlanAllowance_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription"."Plan"("id"),
    CONSTRAINT "PlanAllowance_period_check" CHECK ("period" IN ('MONTHLY')),
    CONSTRAINT "PlanAllowance_quantity_check" CHECK ("included_quantity" >= 0)
);

CREATE TABLE "subscription"."TenantSubscription" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "period_anchor" TIMESTAMPTZ(6) NOT NULL,
    "source" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "created_by" TEXT NOT NULL,
    CONSTRAINT "TenantSubscription_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TenantSubscription_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription"."Plan"("id"),
    CONSTRAINT "TenantSubscription_source_check" CHECK ("source" IN ('MANUAL', 'DEVELOPMENT'))
);
CREATE INDEX "TenantSubscription_tenant_id_idx" ON "subscription"."TenantSubscription"("tenant_id");
-- One open subscription per tenant.
CREATE UNIQUE INDEX "TenantSubscription_one_open_per_tenant"
    ON "subscription"."TenantSubscription"("tenant_id") WHERE "ended_at" IS NULL;

CREATE TABLE "subscription"."AllowanceUsage" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "allowance_key" TEXT NOT NULL,
    "send_key" TEXT NOT NULL,
    "period_start" TIMESTAMPTZ(6) NOT NULL,
    "state" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'SEND',
    "reserved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reserved_until" TIMESTAMPTZ(6) NOT NULL,
    "finalized_at" TIMESTAMPTZ(6),
    CONSTRAINT "AllowanceUsage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AllowanceUsage_state_check" CHECK ("state" IN ('RESERVED', 'CONSUMED', 'RELEASED')),
    CONSTRAINT "AllowanceUsage_origin_check" CHECK ("origin" IN ('SEND', 'HISTORICAL'))
);
CREATE UNIQUE INDEX "AllowanceUsage_tenant_id_allowance_key_send_key_key"
    ON "subscription"."AllowanceUsage"("tenant_id", "allowance_key", "send_key");
CREATE INDEX "AllowanceUsage_tenant_id_allowance_key_period_start_idx"
    ON "subscription"."AllowanceUsage"("tenant_id", "allowance_key", "period_start");

-- Plan catalog seed: the V1 Aramo Sign included allowance (ratified: 100 envelopes
-- per tenant per monthly billing period). A catalog row only; no tenant is
-- subscribed by this migration.
INSERT INTO "subscription"."Plan" ("id", "key", "name")
VALUES ('019a0000-5150-7000-8000-000000000001'::uuid, 'aramo-sign-included-v1', 'Aramo Sign — included allowance')
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "subscription"."PlanAllowance" ("plan_id", "allowance_key", "included_quantity", "period")
VALUES ('019a0000-5150-7000-8000-000000000001'::uuid, 'esign.envelopes', 100, 'MONTHLY')
ON CONFLICT ("plan_id", "allowance_key") DO NOTHING;
