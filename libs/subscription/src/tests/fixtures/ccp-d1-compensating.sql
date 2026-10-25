-- CCP-D1 compensating SQL (recorded in doc/ccp/slices/CCP-D1-pre-execution.md section 3.3).
-- Removes every D1 object. Everything dropped is derived or registry-only: the AllowanceUsage
-- ledger rows are untouched (only the derived rollup_xid column and its triggers go).
-- Executed by the D1 spec only. Production execution is NOT authorized (PBD section 7.5, A0-C15).
SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS "allowance_usage_rollup_vacated" ON "subscription"."AllowanceUsage";
DROP TRIGGER IF EXISTS "allowance_usage_rollup_xid" ON "subscription"."AllowanceUsage";
DROP FUNCTION IF EXISTS "subscription"."ccp_d1_allowance_usage_vacated"();
DROP FUNCTION IF EXISTS "subscription"."ccp_d1_allowance_usage_rollup_xid"();
ALTER TABLE "subscription"."AllowanceUsage" DROP COLUMN IF EXISTS "rollup_xid";
DROP TABLE IF EXISTS "subscription"."UsageRollupVacatedBucket";
DROP TABLE IF EXISTS "subscription"."UsageRollupRun";
DROP TABLE IF EXISTS "subscription"."UsageRollupWatermark";
DROP TABLE IF EXISTS "subscription"."UsageRollupPeriod";
DROP TABLE IF EXISTS "subscription"."UsageRollupDaily";
DROP TABLE IF EXISTS "subscription"."UsageMetric";
DROP FUNCTION IF EXISTS "subscription"."ccp_d1_usage_rollup_run_guard"();
DROP FUNCTION IF EXISTS "subscription"."ccp_d1_usage_metric_guard"();
