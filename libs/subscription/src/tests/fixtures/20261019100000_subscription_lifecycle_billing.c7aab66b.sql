-- TEST FIXTURE — the ORIGINAL revision of 20261019100000 (commit c7aab66b),
-- which seeded the superseded single paid plan aramo-sign-business-v1. Used
-- only to prove Commercial Plans Amendment A1 upgrades such a database safely.
-- Aramo Sign standalone launch (Aramo-Sign-Standalone-Product-Final-Implementation-
-- Authorization-v1_0) — subscription lifecycle + billing-provider linkage.
-- Stripe is authoritative for payment events; Aramo is authoritative for the
-- effective entitlement. Additive only: existing rows become ACTIVE (unchanged
-- behaviour for the operator-opened MANUAL/DEVELOPMENT subscriptions).

-- 1. Subscription lifecycle + provider linkage.
ALTER TABLE "subscription"."TenantSubscription"
    ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN "billing_provider" TEXT,
    ADD COLUMN "billing_account_ref" TEXT,
    ADD COLUMN "billing_subscription_ref" TEXT,
    ADD COLUMN "current_period_end" TIMESTAMPTZ(6),
    ADD COLUMN "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "grace_until" TIMESTAMPTZ(6),
    ADD COLUMN "provider_state_at" TIMESTAMPTZ(6),
    ADD COLUMN "activated_by" TEXT;
ALTER TABLE "subscription"."TenantSubscription"
    ADD CONSTRAINT "TenantSubscription_status_check"
    CHECK ("status" IN ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE'));
ALTER TABLE "subscription"."TenantSubscription"
    ADD CONSTRAINT "TenantSubscription_billing_provider_check"
    CHECK ("billing_provider" IS NULL OR "billing_provider" IN ('STRIPE'));
ALTER TABLE "subscription"."TenantSubscription" DROP CONSTRAINT "TenantSubscription_source_check";
ALTER TABLE "subscription"."TenantSubscription"
    ADD CONSTRAINT "TenantSubscription_source_check"
    CHECK ("source" IN ('MANUAL', 'DEVELOPMENT', 'SELF_SERVICE'));
-- One Aramo row per provider subscription.
CREATE UNIQUE INDEX "TenantSubscription_billing_subscription_ref_key"
    ON "subscription"."TenantSubscription"("billing_provider", "billing_subscription_ref")
    WHERE "billing_subscription_ref" IS NOT NULL;

-- 2. Sellable plans. Prices live in the billing provider (never in Aramo data):
-- an operator maps each sellable plan key to a provider price id in config.
ALTER TABLE "subscription"."Plan"
    ADD COLUMN "sellable" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "description" TEXT;

-- The launch plan: 100 Aramo Sign envelopes per BUSINESS tenant per monthly
-- billing period, no rollover (ratified). Catalog row only; nobody is subscribed.
INSERT INTO "subscription"."Plan" ("id", "key", "name", "sellable", "description")
VALUES ('019a0000-5150-7000-8000-000000000002'::uuid, 'aramo-sign-business-v1', 'Aramo Sign Business', true,
        '100 envelopes per month for your organization. Unused envelopes do not roll over.')
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "subscription"."PlanAllowance" ("plan_id", "allowance_key", "included_quantity", "period")
VALUES ('019a0000-5150-7000-8000-000000000002'::uuid, 'sign.envelopes', 100, 'MONTHLY')
ON CONFLICT ("plan_id", "allowance_key") DO NOTHING;

-- 3. Who started a checkout, for which tenant and plan. The subscribing-owner
-- activation reads this; it is never inferred from the payment alone.
CREATE TABLE "subscription"."CheckoutIntent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_session_ref" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    CONSTRAINT "CheckoutIntent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CheckoutIntent_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription"."Plan"("id"),
    CONSTRAINT "CheckoutIntent_status_check" CHECK ("status" IN ('CREATED', 'COMPLETED', 'EXPIRED')),
    CONSTRAINT "CheckoutIntent_provider_check" CHECK ("provider" IN ('STRIPE'))
);
CREATE UNIQUE INDEX "CheckoutIntent_provider_session_ref_key"
    ON "subscription"."CheckoutIntent"("provider", "provider_session_ref") WHERE "provider_session_ref" IS NOT NULL;
CREATE INDEX "CheckoutIntent_tenant_id_idx" ON "subscription"."CheckoutIntent"("tenant_id");

-- 4. Billing-provider events, processed at most once. Forged events never reach
-- this table (the signature is verified first). A failed attempt is NOT recorded,
-- so the provider's redelivery is processed again.
CREATE TABLE "subscription"."BillingEvent" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_created_at" TIMESTAMPTZ(6) NOT NULL,
    "tenant_id" UUID,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BillingEvent_outcome_check" CHECK ("outcome" IN ('APPLIED', 'IGNORED', 'STALE'))
);
CREATE UNIQUE INDEX "BillingEvent_provider_event_key" ON "subscription"."BillingEvent"("provider", "provider_event_id");
CREATE INDEX "BillingEvent_tenant_id_idx" ON "subscription"."BillingEvent"("tenant_id");
