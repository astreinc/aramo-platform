-- CCP-A3 compensating SQL (doc/ccp/slices/CCP-A3-acceptance.md section 9). NOT a forward migration.
-- Reverses 20261025120000_ccp_a3_change_request_approval: drops the CommercialAuditEvent FK and index A3
-- added, then CommercialApproval, CommercialChangeRequest and CommercialOperatorAttestation with their
-- triggers, then their four functions. The function dropped is the A3 body of
-- guard_commercial_change_request() that the CCP-A9 compensation restores.
-- Refused (RAISE, nothing changed) while any CommercialChangeRequest, CommercialApproval or
-- CommercialOperatorAttestation row exists, and while the CCP-A4 product registry CHECK is still on the
-- request table (compensate CCP-A4 first). Run with a code revert of A3.
-- Production execution needs separate PO authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CommercialChangeRequest_product_key_registry_check') THEN
    RAISE EXCEPTION 'CCP-A3 compensation refused: the CCP-A4 product registry CHECK is still present (compensate CCP-A4 first)';
  END IF;
  IF EXISTS (SELECT 1 FROM "subscription"."CommercialChangeRequest")
     OR EXISTS (SELECT 1 FROM "subscription"."CommercialApproval")
     OR EXISTS (SELECT 1 FROM "subscription"."CommercialOperatorAttestation") THEN
    RAISE EXCEPTION 'CCP-A3 compensation refused: a change request, approval or operator attestation exists';
  END IF;
END
$$;
ALTER TABLE "subscription"."CommercialAuditEvent" DROP CONSTRAINT "CommercialAuditEvent_change_request_id_fkey";
DROP INDEX "subscription"."CommercialAuditEvent_change_request_id_created_at_id_idx";
DROP TABLE "subscription"."CommercialApproval";
DROP TABLE "subscription"."CommercialChangeRequest";
DROP TABLE "subscription"."CommercialOperatorAttestation";
DROP FUNCTION "subscription"."guard_commercial_change_request"();
DROP FUNCTION "subscription"."guard_commercial_approval_insert"();
DROP FUNCTION "subscription"."reject_commercial_approval_mutation"();
DROP FUNCTION "subscription"."guard_commercial_operator_attestation"();
