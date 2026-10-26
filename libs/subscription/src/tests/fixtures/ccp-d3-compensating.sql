-- CCP-D3 compensating SQL (doc/ccp/slices/CCP-D3-acceptance.md section 6). NOT a forward migration.
-- Reverses 20261026090000_ccp_d3_operational_alerts: drops the guard trigger, CommercialOperationalAlert and
-- its guard function. The rows are derived observations (a scan recomputes them), and no source table
-- depends on them. The compensation is still refused (RAISE, nothing changed) while any alert is OPEN: an
-- open operator exception must be resolved or exported before its register is dropped. Run with a code
-- revert of D3 (and CCP_ALERTS_ENABLED unset).
-- Production execution needs separate PO authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "subscription"."CommercialOperationalAlert" WHERE "status" = 'OPEN') THEN
    RAISE EXCEPTION 'CCP-D3 compensation refused: an OPEN operational alert exists';
  END IF;
END
$$;
DROP TRIGGER "commercial_operational_alert_guard" ON "subscription"."CommercialOperationalAlert";
DROP TABLE "subscription"."CommercialOperationalAlert";
DROP FUNCTION "subscription"."guard_commercial_operational_alert"();
