-- Aramo Sign Business Per-Seat Pricing, Implementation Directive v1.0 (LOCKED) §3.1, with Amendment A1
-- (No Existing Subscribers, LOCKED). Schema part. splitDdl-safe: no semicolons in comment lines.
-- ADD-not-rename: no existing column changes meaning. IDEMPOTENT (IF NOT EXISTS / DROP IF EXISTS).
--
--   1. PlanVersion.content gains the OPTIONAL format-1 key "price_unit", present only as "SEAT" (absent =
--      per account). It is part of the content, so the existing checksum CHECK and the PlanVersion
--      immutability trigger cover it (the unit_prices / regional_prices precedent). Every existing row
--      carries no such key and keeps its exact bytes and checksum. A shape CHECK holds it to a BUSINESS
--      self-service plan with a list price. The live projection ccp_plan_live_content is unchanged (the
--      unit is a version term, not a live-row column).
--   2. TenantSubscription.seat_quantity (the purchased seats, read from the provider subscription item
--      quantity) and seat_pending_quantity (a decrease scheduled for the end of the current period, O-2).
--      CheckoutIntent.seat_quantity (the seats bought at checkout). NULL = not seat-priced.
--   The catalog data (A1-2..A1-5) is the next migration, 20261108100100_sign_business_per_seat_catalog, so a
--   gated spec that seeds a Standard Business subscription first can apply this schema alone.

SET LOCAL lock_timeout = '5s';

-- 1. The price_unit shape.
ALTER TABLE "subscription"."PlanVersion" DROP CONSTRAINT IF EXISTS "PlanVersion_price_unit_check";
ALTER TABLE "subscription"."PlanVersion"
    ADD CONSTRAINT "PlanVersion_price_unit_check" CHECK (
        NOT ("content" ? 'price_unit')
        OR (jsonb_typeof("content" -> 'price_unit') = 'string'
            AND ("content" ->> 'price_unit') = 'SEAT'
            AND ("content" -> 'plan' ->> 'tenant_kind') = 'BUSINESS'
            AND ("content" -> 'plan' ->> 'sales_model') = 'SELF_SERVICE'
            AND jsonb_typeof("content" -> 'plan' -> 'list_price_minor') = 'number'));

-- 2. Seat quantities.
ALTER TABLE "subscription"."TenantSubscription" ADD COLUMN IF NOT EXISTS "seat_quantity" INTEGER;
ALTER TABLE "subscription"."TenantSubscription" ADD COLUMN IF NOT EXISTS "seat_pending_quantity" INTEGER;
ALTER TABLE "subscription"."TenantSubscription" DROP CONSTRAINT IF EXISTS "TenantSubscription_seat_quantity_check";
ALTER TABLE "subscription"."TenantSubscription"
    ADD CONSTRAINT "TenantSubscription_seat_quantity_check" CHECK ("seat_quantity" IS NULL OR "seat_quantity" >= 1);
ALTER TABLE "subscription"."TenantSubscription" DROP CONSTRAINT IF EXISTS "TenantSubscription_seat_pending_quantity_check";
ALTER TABLE "subscription"."TenantSubscription"
    ADD CONSTRAINT "TenantSubscription_seat_pending_quantity_check" CHECK (
        "seat_pending_quantity" IS NULL OR ("seat_pending_quantity" >= 1 AND "seat_quantity" IS NOT NULL));

ALTER TABLE "subscription"."CheckoutIntent" ADD COLUMN IF NOT EXISTS "seat_quantity" INTEGER;
ALTER TABLE "subscription"."CheckoutIntent" DROP CONSTRAINT IF EXISTS "CheckoutIntent_seat_quantity_check";
ALTER TABLE "subscription"."CheckoutIntent"
    ADD CONSTRAINT "CheckoutIntent_seat_quantity_check" CHECK ("seat_quantity" IS NULL OR "seat_quantity" >= 1);
