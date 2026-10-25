-- CCP merge train — compensating SQL for 20261027000100_ccp_constraint_union (TD-MERGE-CHECK-1). NOT a forward migration.
-- Re-asserts "CommercialChangeApplication_action_type_check" as the LAST-SORTING slice migration wrote it
-- (CCP-C2 20261026060000: the A6 list plus CONVERSION), which is what the chain holds without the union.
-- Refused (RAISE, nothing changed) while an application row of a type that list lacks exists
-- (ENTITLEMENT_REVOKE from CCP-A7, SUPPORT_EXTENSION from CCP-A8): those rows would violate it. Valid only
-- as a step of rolling back A7 and A8, in reverse order. Production execution needs separate PO
-- authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "subscription"."CommercialChangeApplication" WHERE "action_type" IN ('ENTITLEMENT_REVOKE', 'SUPPORT_EXTENSION')) THEN
    RAISE EXCEPTION 'CCP constraint-union compensation refused: an ENTITLEMENT_REVOKE or SUPPORT_EXTENSION application row exists';
  END IF;
END
$$;
ALTER TABLE "subscription"."CommercialChangeApplication"
    DROP CONSTRAINT "CommercialChangeApplication_action_type_check",
    ADD CONSTRAINT "CommercialChangeApplication_action_type_check" CHECK ("action_type" IN (
        'SUBSCRIPTION_OPEN', 'SUBSCRIPTION_CHANGE', 'SUBSCRIPTION_END', 'ENTITLEMENT_GRANT', 'CONVERSION'));
