-- CCP-B4 compensating SQL (doc/ccp/slices/CCP-B4-acceptance.md section 6). NOT a forward migration.
-- Reverses 20261026030000_ccp_b4_enterprise_contracts: drops ContractAmendment and Contract with their
-- triggers, the three trigger functions and the two validators. Refused (RAISE, nothing changed) while any
-- Contract or ContractAmendment row exists. Change requests whose frozen payloads carry contract blocks stay
-- valid history. Run with a code revert of B4.
-- Production execution needs separate PO authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "subscription"."Contract") OR EXISTS (SELECT 1 FROM "subscription"."ContractAmendment") THEN
    RAISE EXCEPTION 'CCP-B4 compensation refused: contract records exist';
  END IF;
END
$$;
DROP TABLE "subscription"."ContractAmendment";
DROP TABLE "subscription"."Contract";
DROP FUNCTION "subscription"."guard_contract_amendment_insert"();
DROP FUNCTION "subscription"."guard_contract_insert"();
DROP FUNCTION "subscription"."reject_contract_mutation"();
DROP FUNCTION "subscription"."ccp_b4_valid_evidence_documents"(JSONB);
DROP FUNCTION "subscription"."ccp_b4_valid_terms"(JSONB);
