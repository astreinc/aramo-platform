-- Aramo Sign Monthly and Annual-Commitment Pricing Directive v1.0 (LOCKED 2026-11-15) §3 items 1-4.
-- splitDdl-safe: no semicolons in comment lines. ADD-not-rename: no existing column changes meaning, and
-- no existing row is rewritten (every new column is NULL on existing rows, read as the legacy term).
--
--   1. PlanVersion.content gains the OPTIONAL format-1 key "terms" (an array, the strict parser in
--      plan-version.ts checks each entry). Absent on every existing version, so every checksum is unchanged.
--   2. PlanVersionPrice.term: the billing term a web (Stripe / Razorpay) pin sells. NULL = the legacy pin of a
--      version without "terms" (its one derived term). A store pin never carries a term (the stores sell the
--      MONTHLY term only, by interval). The one-web-pin-per-(version, provider) index (same name) becomes one per
--      (version, provider, term), a NULL term counting as one legacy slot, so a two-term version pins one
--      Stripe price per term. PlanVersionPrice stays insert-only (its guard trigger is unchanged).
--   3. CheckoutIntent.term: the term a web checkout chose (NULL on every existing intent = legacy).
--   4. TenantSubscription.term: the term a self-service subscription was sold on (NULL on every existing row =
--      legacy: its commitment columns stand as written).

SET LOCAL lock_timeout = '5s';

-- 1. The terms shape.
ALTER TABLE "subscription"."PlanVersion" DROP CONSTRAINT IF EXISTS "PlanVersion_terms_shape_check";
ALTER TABLE "subscription"."PlanVersion"
    ADD CONSTRAINT "PlanVersion_terms_shape_check" CHECK (
        NOT ("content" ? 'terms') OR (jsonb_typeof("content" -> 'terms') = 'array' AND jsonb_array_length("content" -> 'terms') BETWEEN 1 AND 2));

-- 2. The pin term.
ALTER TABLE "subscription"."PlanVersionPrice" ADD COLUMN IF NOT EXISTS "term" TEXT;
ALTER TABLE "subscription"."PlanVersionPrice" DROP CONSTRAINT IF EXISTS "PlanVersionPrice_term_check";
ALTER TABLE "subscription"."PlanVersionPrice"
    ADD CONSTRAINT "PlanVersionPrice_term_check" CHECK (
        "term" IS NULL OR ("provider" IN ('STRIPE', 'RAZORPAY') AND "term" IN ('MONTHLY', 'ANNUAL_COMMIT')));

-- The index keeps its name (the M-A12 / India Billing precedent), now keyed by the term slot as well.
DROP INDEX IF EXISTS "subscription"."PlanVersionPrice_plan_version_id_provider_key";
CREATE UNIQUE INDEX "PlanVersionPrice_plan_version_id_provider_key"
    ON "subscription"."PlanVersionPrice"("plan_version_id", "provider", COALESCE("term", 'LEGACY')) WHERE "provider" IN ('STRIPE', 'RAZORPAY');

-- 3. The checkout term.
ALTER TABLE "subscription"."CheckoutIntent" ADD COLUMN IF NOT EXISTS "term" TEXT;
ALTER TABLE "subscription"."CheckoutIntent" DROP CONSTRAINT IF EXISTS "CheckoutIntent_term_check";
ALTER TABLE "subscription"."CheckoutIntent"
    ADD CONSTRAINT "CheckoutIntent_term_check" CHECK ("term" IS NULL OR "term" IN ('MONTHLY', 'ANNUAL_COMMIT'));

-- 4. The subscription term.
ALTER TABLE "subscription"."TenantSubscription" ADD COLUMN IF NOT EXISTS "term" TEXT;
ALTER TABLE "subscription"."TenantSubscription" DROP CONSTRAINT IF EXISTS "TenantSubscription_term_check";
ALTER TABLE "subscription"."TenantSubscription"
    ADD CONSTRAINT "TenantSubscription_term_check" CHECK ("term" IS NULL OR "term" IN ('MONTHLY', 'ANNUAL_COMMIT'));
