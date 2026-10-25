-- CCP-A7 (entitlement) compensating SQL (doc/ccp/slices/CCP-A7-acceptance.md section 8, step 2). NOT a forward migration.
-- Reverses entitlement 20261026000000_ccp_a7_entitlement_revoke_provenance: drops the ledger and guard
-- triggers and functions, TenantEntitlementEvent, the three CHECKs, the active-capability index and the six
-- provenance and revoke columns. No TenantEntitlement row is removed. The ledger history is dropped with
-- its table. Refused (RAISE, nothing changed) while any row is revoked or carries a commercial
-- granted_source (MANUAL, PLAN, PROMOTION), and while the CCP-A7 subscription half (20261026000100) is
-- still applied (compensate it first). Run with a code revert of A7.
-- Production execution needs separate PO authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'subscription' AND table_name = 'CommercialChangeApplication' AND column_name = 'capabilities_revoked') THEN
    RAISE EXCEPTION 'CCP-A7 entitlement compensation refused: the CCP-A7 subscription half is still applied (compensate it first)';
  END IF;
  IF EXISTS (SELECT 1 FROM "entitlement"."TenantEntitlement"
              WHERE "revoked_at" IS NOT NULL OR "granted_source" IN ('MANUAL', 'PLAN', 'PROMOTION')) THEN
    RAISE EXCEPTION 'CCP-A7 entitlement compensation refused: revoked or commercially sourced rows exist';
  END IF;
END
$$;
DROP TRIGGER "ccp_a7_tenant_entitlement_ledger" ON "entitlement"."TenantEntitlement";
DROP TRIGGER "ccp_a7_tenant_entitlement_guard" ON "entitlement"."TenantEntitlement";
DROP FUNCTION "entitlement".ccp_a7_record_tenant_entitlement_event();
DROP FUNCTION "entitlement".ccp_a7_guard_tenant_entitlement();
DROP TABLE "entitlement"."TenantEntitlementEvent";
DROP FUNCTION "entitlement".ccp_a7_reject_entitlement_event_mutation();
DROP INDEX "entitlement"."TenantEntitlement_capability_active_idx";
ALTER TABLE "entitlement"."TenantEntitlement"
    DROP CONSTRAINT "TenantEntitlement_revoke_check",
    DROP CONSTRAINT "TenantEntitlement_commercial_source_check",
    DROP CONSTRAINT "TenantEntitlement_granted_source_check",
    DROP COLUMN "revoke_change_request_id",
    DROP COLUMN "revoked_by",
    DROP COLUMN "revoked_at",
    DROP COLUMN "change_request_id",
    DROP COLUMN "granted_by",
    DROP COLUMN "granted_source";
