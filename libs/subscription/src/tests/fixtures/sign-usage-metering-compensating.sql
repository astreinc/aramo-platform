-- Compensating SQL for migration 20261101200000_sign_usage_metering (documented, not shipped).
-- Refused (RAISE, nothing changed) once any usage was recorded or any unit price was written:
-- the ledger is append-only billing evidence and is never dropped with data in it.
DO $comp$
BEGIN
  IF EXISTS (SELECT 1 FROM "subscription"."UsageLedgerEntry") THEN
    RAISE EXCEPTION 'sign usage metering compensation refused: the usage ledger has entries';
  END IF;
  IF EXISTS (SELECT 1 FROM "subscription"."PlanVersionUnitPrice") THEN
    RAISE EXCEPTION 'sign usage metering compensation refused: a unit price exists';
  END IF;
END
$comp$;

DROP TABLE "subscription"."UsageProviderReport";
DROP TABLE "subscription"."UsageLedgerEntry";
DROP TABLE "subscription"."PlanVersionUnitPrice";
DROP TABLE "subscription"."MeteredUnit";
DROP FUNCTION "subscription"."guard_usage_provider_report"();
DROP FUNCTION "subscription"."guard_usage_ledger_entry_insert"();
DROP FUNCTION "subscription"."sign_usage_ledger_append_only"();
DROP FUNCTION "subscription"."guard_plan_version_unit_price"();
DROP FUNCTION "subscription"."sign_metered_unit_guard"();
