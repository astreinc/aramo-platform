-- CCP-D1 compensating SQL (recorded in doc/ccp/slices/CCP-D1-pre-execution.md section 3.3).
-- Removes every D1 object. Everything dropped is derived, provenance-only or registry-only: the
-- AllowanceUsage ledger (its columns and rows) is untouched. Only the change-log trigger on it goes.
-- Executed by the D1 spec only. Production execution is NOT authorized (PBD section 7.5, A0-C15).
SET LOCAL lock_timeout = '5s';
DROP TRIGGER IF EXISTS "allowance_usage_change_log" ON "subscription"."AllowanceUsage";
DROP FUNCTION IF EXISTS "subscription"."ccp_d1_allowance_usage_change"();
DROP TABLE IF EXISTS "subscription"."AllowanceUsageChange";
DROP FUNCTION IF EXISTS "subscription"."ccp_d1_allowance_usage_change_guard"();
DROP TABLE IF EXISTS "subscription"."UsageRollupRun";
DROP TABLE IF EXISTS "subscription"."UsageRollupWatermark";
DROP TABLE IF EXISTS "subscription"."UsageRollupPeriod";
DROP TABLE IF EXISTS "subscription"."UsageRollupDaily";
DROP TABLE IF EXISTS "subscription"."UsageMetric";
DROP FUNCTION IF EXISTS "subscription"."ccp_d1_usage_rollup_run_guard"();
DROP FUNCTION IF EXISTS "subscription"."ccp_d1_usage_metric_guard"();
