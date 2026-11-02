-- Compensating SQL for migration 20261101300000_sign_usage_metering (documented, not shipped).
-- Refused (RAISE, nothing changed) once any billable event or reconciliation was recorded: the ledger is
-- append-only billing evidence and is never dropped with data in it. Unit prices live in PlanVersion.content
-- (Amendment A3 D1) and are not touched here: a published version's content is immutable approved catalog data.
DO $comp$
BEGIN
  IF EXISTS (SELECT 1 FROM "subscription"."UsageLedgerEntry") THEN
    RAISE EXCEPTION 'sign usage metering compensation refused: the usage ledger has entries';
  END IF;
  IF EXISTS (SELECT 1 FROM "subscription"."UsagePeriodReconciliation") THEN
    RAISE EXCEPTION 'sign usage metering compensation refused: a billing period was reconciled';
  END IF;
END
$comp$;

DROP TABLE "subscription"."UsagePeriodReconciliation";
DROP TABLE "subscription"."UsageProviderReport";
DROP TABLE "subscription"."UsageLedgerEntry";
DROP TABLE "subscription"."MeteredUnit";
DROP FUNCTION "subscription"."sign_usage_reconciliation_append_only"();
DROP FUNCTION "subscription"."guard_usage_provider_report"();
DROP FUNCTION "subscription"."guard_usage_ledger_entry_insert"();
DROP FUNCTION "subscription"."sign_usage_ledger_append_only"();
DROP FUNCTION "subscription"."sign_plan_version_unit_price"(UUID, TEXT);
DROP FUNCTION "subscription"."sign_metered_unit_guard"();
