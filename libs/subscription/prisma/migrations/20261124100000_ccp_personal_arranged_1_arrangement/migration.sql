-- CCP-PERSONAL-ARRANGED-1 (Aramo-CCP-Personal-Arranged-Plan-Directive-v1_0-LOCKED, PO 2026-11-23) P-2.
-- splitDdl-safe: no semicolons in comment lines. ADD-not-rename: one new nullable column, no existing row is
-- rewritten (every existing row reads NULL = not arranged, exactly as before).
--
--   TenantSubscription.arrangement: a governed (MANUAL) subscription arranged by Aramo outside the store and
--   the web billing provider. COMP = no charge (internal or courtesy: no commitment, never revenue). AGREED = a
--   price agreed outside the store and the web billing provider (behaves as any other managed row).
--   NULL = not arranged.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "subscription"."TenantSubscription" ADD COLUMN IF NOT EXISTS "arrangement" TEXT;
ALTER TABLE "subscription"."TenantSubscription" DROP CONSTRAINT IF EXISTS "TenantSubscription_arrangement_check";
ALTER TABLE "subscription"."TenantSubscription"
    ADD CONSTRAINT "TenantSubscription_arrangement_check" CHECK ("arrangement" IS NULL OR "arrangement" IN ('COMP', 'AGREED'));
