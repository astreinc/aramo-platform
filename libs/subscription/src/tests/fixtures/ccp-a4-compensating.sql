-- CCP-A4 compensating SQL (doc/ccp/slices/CCP-A4-pre-execution.md section 5). NOT a forward migration.
-- Reverses 20261025140000_ccp_a4_product_dimension while every row is sign (MP-A2 N-9).
-- Applied together with a code revert of A4. Production execution needs separate PO authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "subscription"."TenantSubscription" WHERE "product_key" <> 'sign' OR "composition_role" <> 'BASE')
     OR EXISTS (SELECT 1 FROM "subscription"."Plan" WHERE "product_key" <> 'sign') THEN
    RAISE EXCEPTION 'CCP-A4 compensation refused: a non-sign or non-BASE row exists';
  END IF;
  IF EXISTS (SELECT 1 FROM "subscription"."TenantSubscription" WHERE "ended_at" IS NULL GROUP BY "tenant_id" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'CCP-A4 compensation refused: a tenant has more than one open subscription';
  END IF;
END
$$;
CREATE UNIQUE INDEX "TenantSubscription_one_open_per_tenant" ON "subscription"."TenantSubscription"("tenant_id") WHERE "ended_at" IS NULL;
DROP INDEX "subscription"."TenantSubscription_one_open_base_per_tenant_product";
ALTER TABLE "subscription"."TenantSubscription" DROP CONSTRAINT "TenantSubscription_plan_id_product_key_fkey";
ALTER TABLE "subscription"."Plan" DROP CONSTRAINT "Plan_id_product_key_key";
ALTER TABLE "subscription"."TenantSubscription" DROP COLUMN "composition_role", DROP COLUMN "product_key";
ALTER TABLE "subscription"."Plan" DROP COLUMN "product_key";
-- CCP-A3 interplay: restore the A3 interim CHECK when the A4 registry CHECK is present (no-op otherwise).
-- Exactly as 20261025120000_ccp_a3_change_request_approval wrote it: NULL stays admitted (catalog, policy
-- and role requests carry no product). CCP FIX1 TD-D5-4 corrected the earlier sign-only form.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CommercialChangeRequest_product_key_registry_check') THEN
    ALTER TABLE "subscription"."CommercialChangeRequest" DROP CONSTRAINT "CommercialChangeRequest_product_key_registry_check";
    ALTER TABLE "subscription"."CommercialChangeRequest" ADD CONSTRAINT "CommercialChangeRequest_product_key_check" CHECK ("product_key" IS NULL OR "product_key" IN ('sign'));
  END IF;
END
$$;
