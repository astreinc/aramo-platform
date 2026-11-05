-- Aramo Sign Mobile M-A12 W1-G (LOCKED) with Amendment A1 (A1-1, A1-2, A1-3): in-app store billing.
-- splitDdl-safe: no semicolons in comment lines. ADD-not-rename: no existing column changes meaning.
--
--   1. Every provider CHECK a store row must pass is widened from STRIPE to STRIPE, APP_STORE, GOOGLE_PLAY:
--      PlanVersionPrice, TenantSubscription.billing_provider, CheckoutIntent (the store purchase intent),
--      BillingWebhookInbox (App Store Server Notifications v2, Google RTDN) and BillingReconciliationFlag
--      (the activation guards record holds on store subscriptions too). The Stripe-only tables
--      (TenantBillingAccount, BillingProviderCommand, SelfServiceBillingRequest, CommercialBillingAdjustment)
--      stay STRIPE: no store row is ever written there.
--   2. PlanVersionPrice pins carry an interval (MONTH or YEAR, A1-1). Existing (Stripe) pins are MONTH,
--      the only Stripe interval (ADD COLUMN with a default fires no row trigger, the pins stay immutable).
--      One Stripe pin per version is kept and a Stripe price still belongs to ONE version (the two
--      existing unique indexes, narrowed to STRIPE rows). A store pin is unique per (version, provider, interval). A store product id is
--      stable across plan versions (the store has no per-version price id), so a store product may be
--      pinned to several versions of ONE plan with ONE interval, never to another plan (trigger).
--   3. The store subscription references on TenantSubscription (the product and environment the store
--      reports, and the billed interval) and the store product on the CheckoutIntent. Null for Stripe rows.
--   4. Regional list prices (A1-3) are the optional "regional_prices" array of PlanVersion.content, so the
--      existing content checksum and the PlanVersion immutability trigger keep a published regional price
--      immutable with its version (the A3 D1 unit_prices precedent). Only a shape CHECK is added here.

SET LOCAL lock_timeout = '5s';

-- 1. Provider CHECK widening.
ALTER TABLE "subscription"."PlanVersionPrice" DROP CONSTRAINT "PlanVersionPrice_provider_check";
ALTER TABLE "subscription"."PlanVersionPrice"
    ADD CONSTRAINT "PlanVersionPrice_provider_check" CHECK ("provider" IN ('STRIPE', 'APP_STORE', 'GOOGLE_PLAY'));

ALTER TABLE "subscription"."TenantSubscription" DROP CONSTRAINT "TenantSubscription_billing_provider_check";
ALTER TABLE "subscription"."TenantSubscription"
    ADD CONSTRAINT "TenantSubscription_billing_provider_check"
    CHECK ("billing_provider" IS NULL OR "billing_provider" IN ('STRIPE', 'APP_STORE', 'GOOGLE_PLAY'));

ALTER TABLE "subscription"."CheckoutIntent" DROP CONSTRAINT "CheckoutIntent_provider_check";
ALTER TABLE "subscription"."CheckoutIntent"
    ADD CONSTRAINT "CheckoutIntent_provider_check" CHECK ("provider" IN ('STRIPE', 'APP_STORE', 'GOOGLE_PLAY'));

ALTER TABLE "subscription"."BillingWebhookInbox" DROP CONSTRAINT "BillingWebhookInbox_provider_check";
ALTER TABLE "subscription"."BillingWebhookInbox"
    ADD CONSTRAINT "BillingWebhookInbox_provider_check" CHECK ("provider" IN ('STRIPE', 'APP_STORE', 'GOOGLE_PLAY'));

ALTER TABLE "subscription"."BillingReconciliationFlag" DROP CONSTRAINT "BillingReconciliationFlag_provider_check";
ALTER TABLE "subscription"."BillingReconciliationFlag"
    ADD CONSTRAINT "BillingReconciliationFlag_provider_check" CHECK ("provider" IN ('STRIPE', 'APP_STORE', 'GOOGLE_PLAY'));

-- 2. Pin interval and the pin uniqueness rules.
ALTER TABLE "subscription"."PlanVersionPrice" ADD COLUMN "interval" TEXT NOT NULL DEFAULT 'MONTH';
ALTER TABLE "subscription"."PlanVersionPrice"
    ADD CONSTRAINT "PlanVersionPrice_interval_check" CHECK ("interval" IN ('MONTH', 'YEAR'));
ALTER TABLE "subscription"."PlanVersionPrice"
    ADD CONSTRAINT "PlanVersionPrice_stripe_interval_check" CHECK ("provider" <> 'STRIPE' OR "interval" = 'MONTH');

-- The two Stripe rules keep their index names, narrowed to STRIPE rows (a partial unique index each).
DROP INDEX "subscription"."PlanVersionPrice_plan_version_id_provider_key";
CREATE UNIQUE INDEX "PlanVersionPrice_plan_version_id_provider_key"
    ON "subscription"."PlanVersionPrice"("plan_version_id", "provider") WHERE "provider" = 'STRIPE';
DROP INDEX "subscription"."PlanVersionPrice_provider_provider_price_ref_key";
CREATE UNIQUE INDEX "PlanVersionPrice_provider_provider_price_ref_key"
    ON "subscription"."PlanVersionPrice"("provider", "provider_price_ref") WHERE "provider" = 'STRIPE';
-- A store pin: one per (version, provider, interval).
CREATE UNIQUE INDEX "PlanVersionPrice_store_version_interval_key"
    ON "subscription"."PlanVersionPrice"("plan_version_id", "provider", "interval") WHERE "provider" IN ('APP_STORE', 'GOOGLE_PLAY');
CREATE INDEX "PlanVersionPrice_provider_provider_price_ref_idx"
    ON "subscription"."PlanVersionPrice"("provider", "provider_price_ref");

-- The insert guard (immutable from INSERT, never on a RETIRED version) gains the store product rule.
CREATE OR REPLACE FUNCTION "subscription"."guard_plan_version_price"()
RETURNS TRIGGER AS $$
DECLARE
    "st" TEXT;
    "pid" UUID;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'PlanVersionPrice is immutable (% rejected): a different price is a new version', TG_OP;
    END IF;
    SELECT v."status", v."plan_id" INTO "st", "pid" FROM "subscription"."PlanVersion" v WHERE v."id" = NEW."plan_version_id";
    IF "st" = 'RETIRED' THEN
        RAISE EXCEPTION 'a provider price is never pinned to a RETIRED PlanVersion';
    END IF;
    IF NEW."provider" IN ('APP_STORE', 'GOOGLE_PLAY') AND EXISTS (
        SELECT 1 FROM "subscription"."PlanVersionPrice" o
          JOIN "subscription"."PlanVersion" ov ON ov."id" = o."plan_version_id"
         WHERE o."provider" = NEW."provider" AND o."provider_price_ref" = NEW."provider_price_ref"
           AND (ov."plan_id" <> "pid" OR o."interval" <> NEW."interval")) THEN
        RAISE EXCEPTION 'a store product belongs to one plan and one interval';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Store references (null on every Stripe, MANUAL, DEVELOPMENT and FREE row).
ALTER TABLE "subscription"."TenantSubscription"
    ADD COLUMN "store_product_id" TEXT,
    ADD COLUMN "store_environment" TEXT,
    ADD COLUMN "store_interval" TEXT;
ALTER TABLE "subscription"."TenantSubscription"
    ADD CONSTRAINT "TenantSubscription_store_ref_check" CHECK (
        ("store_product_id" IS NULL AND "store_environment" IS NULL AND "store_interval" IS NULL)
        OR ("billing_provider" IN ('APP_STORE', 'GOOGLE_PLAY') AND "store_product_id" IS NOT NULL
            AND "store_interval" IN ('MONTH', 'YEAR')
            AND ("store_environment" IS NULL OR "store_environment" IN ('Sandbox', 'Production'))));
ALTER TABLE "subscription"."TenantSubscription"
    ADD CONSTRAINT "TenantSubscription_store_monthly_no_commitment_check" CHECK (
        "store_interval" IS DISTINCT FROM 'MONTH' OR ("commitment_start" IS NULL AND "commitment_end" IS NULL));

ALTER TABLE "subscription"."CheckoutIntent" ADD COLUMN "store_product_id" TEXT;
ALTER TABLE "subscription"."CheckoutIntent"
    ADD CONSTRAINT "CheckoutIntent_store_product_check" CHECK (
        ("provider" = 'STRIPE' AND "store_product_id" IS NULL)
        OR ("provider" IN ('APP_STORE', 'GOOGLE_PLAY') AND "store_product_id" IS NOT NULL AND length("store_product_id") BETWEEN 1 AND 200));

-- 4. Regional prices: when present, an array (the strict parser in plan-version.ts checks each entry).
ALTER TABLE "subscription"."PlanVersion"
    ADD CONSTRAINT "PlanVersion_regional_prices_shape_check" CHECK (
        NOT ("content" ? 'regional_prices') OR jsonb_typeof("content" -> 'regional_prices') = 'array');
