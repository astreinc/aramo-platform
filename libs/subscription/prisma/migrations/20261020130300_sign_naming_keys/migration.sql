-- Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED (SHA-256 fa0c08de…) — identifier migration esign → sign.
-- Guarded and idempotent: a second run is a no-op. splitDdl-safe: no semicolons in comment lines.
-- §3.2 / N-5 — subscription allowance, capacity and feature keys esign.* become
-- sign.* (plans and the live usage counters, so a period's consumption carries
-- over). Capacity refs (esign:executed:<id>, esign:certificate:<id>) are storage
-- accounting addresses and are preserved. The append-only metering log is history
-- and is not rewritten.
-- Precondition: no target key already exists beside its source (refused).
-- Postcondition: no esign.* key remains in these five tables.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "subscription"."PlanAllowance" o JOIN "subscription"."PlanAllowance" n ON n."plan_id" = o."plan_id" AND n."allowance_key" = 'sign.' || substr(o."allowance_key", 7) WHERE o."allowance_key" LIKE 'esign.%')
     OR EXISTS (SELECT 1 FROM "subscription"."PlanCapacity" o JOIN "subscription"."PlanCapacity" n ON n."plan_id" = o."plan_id" AND n."capacity_key" = 'sign.' || substr(o."capacity_key", 7) WHERE o."capacity_key" LIKE 'esign.%')
     OR EXISTS (SELECT 1 FROM "subscription"."PlanFeature" o JOIN "subscription"."PlanFeature" n ON n."plan_id" = o."plan_id" AND n."feature_key" = 'sign.' || substr(o."feature_key", 7) WHERE o."feature_key" LIKE 'esign.%') THEN
    RAISE EXCEPTION 'sign naming: a sign.* key already exists beside its esign.* source (partial state refused)';
  END IF;
  UPDATE "subscription"."PlanAllowance" SET "allowance_key" = 'sign.' || substr("allowance_key", 7) WHERE "allowance_key" LIKE 'esign.%';
  UPDATE "subscription"."AllowanceUsage" SET "allowance_key" = 'sign.' || substr("allowance_key", 7) WHERE "allowance_key" LIKE 'esign.%';
  UPDATE "subscription"."PlanCapacity" SET "capacity_key" = 'sign.' || substr("capacity_key", 7) WHERE "capacity_key" LIKE 'esign.%';
  UPDATE "subscription"."CapacityUsage" SET "capacity_key" = 'sign.' || substr("capacity_key", 7) WHERE "capacity_key" LIKE 'esign.%';
  UPDATE "subscription"."PlanFeature" SET "feature_key" = 'sign.' || substr("feature_key", 7) WHERE "feature_key" LIKE 'esign.%';
  IF EXISTS (SELECT 1 FROM "subscription"."PlanAllowance" WHERE "allowance_key" LIKE 'esign.%')
     OR EXISTS (SELECT 1 FROM "subscription"."AllowanceUsage" WHERE "allowance_key" LIKE 'esign.%')
     OR EXISTS (SELECT 1 FROM "subscription"."PlanCapacity" WHERE "capacity_key" LIKE 'esign.%')
     OR EXISTS (SELECT 1 FROM "subscription"."CapacityUsage" WHERE "capacity_key" LIKE 'esign.%')
     OR EXISTS (SELECT 1 FROM "subscription"."PlanFeature" WHERE "feature_key" LIKE 'esign.%') THEN
    RAISE EXCEPTION 'sign naming: esign.* subscription keys remain';
  END IF;
END
$$;
