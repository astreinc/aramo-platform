-- CCP-A5 compensating SQL (doc/ccp/slices/CCP-A5-pre-execution.md section 4). NOT a forward migration.
-- Applied together with a code revert of A5. Refused unless nothing but the migration's v1 exists.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "subscription"."PlanVersion" WHERE "version_number" <> 1 OR "created_by" <> 'migration:20261025160000_ccp_a5_plan_version') THEN
    RAISE EXCEPTION 'CCP-A5 compensation refused: a plan version other than the migration v1 exists';
  END IF;
  IF EXISTS (SELECT 1 FROM "subscription"."PlanVersionPrice") THEN
    RAISE EXCEPTION 'CCP-A5 compensation refused: a provider price is pinned to a version';
  END IF;
  IF EXISTS (SELECT 1 FROM "subscription"."SubscriptionVersionPinEvent") THEN
    RAISE EXCEPTION 'CCP-A5 compensation refused: re-pin history exists';
  END IF;
  IF EXISTS (SELECT 1 FROM "subscription"."TenantSubscription" s
               JOIN "subscription"."PlanVersion" v ON v."id" = s."plan_version_id"
              WHERE v."version_number" <> 1 OR v."plan_id" <> s."plan_id") THEN
    RAISE EXCEPTION 'CCP-A5 compensation refused: a subscription is not on its plan''s v1';
  END IF;
  IF EXISTS (SELECT 1 FROM "subscription"."PlanVersion" v
              WHERE v."content" IS DISTINCT FROM "subscription"."ccp_plan_live_content"(v."plan_id")) THEN
    RAISE EXCEPTION 'CCP-A5 compensation refused: a v1 no longer equals its live rows';
  END IF;
END $$;
DROP TRIGGER "tenant_subscription_version_pin" ON "subscription"."TenantSubscription";
DROP FUNCTION "subscription"."guard_subscription_version_pin"();
DROP TABLE "subscription"."SubscriptionVersionPinEvent";
DROP FUNCTION "subscription"."reject_subscription_version_pin_event_mutation"();
ALTER TABLE "subscription"."TenantSubscription" DROP CONSTRAINT "TenantSubscription_plan_version_id_plan_id_fkey";
ALTER TABLE "subscription"."TenantSubscription" DROP COLUMN "plan_version_id";
DROP TABLE "subscription"."PlanVersionPrice";
DROP FUNCTION "subscription"."guard_plan_version_price"();
DROP TABLE "subscription"."PlanVersion";
DROP FUNCTION "subscription"."guard_plan_version"();
DROP FUNCTION "subscription"."ccp_plan_live_content"(UUID);
DROP FUNCTION "subscription"."ccp_plan_version_checksum"(JSONB);
DROP FUNCTION "subscription"."ccp_canonical_json"(JSONB);
