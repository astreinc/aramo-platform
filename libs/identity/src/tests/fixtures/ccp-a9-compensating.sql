-- CCP-A9 (identity) compensating SQL (doc/ccp/slices/CCP-A9-acceptance.md section 6). NOT a forward migration.
-- Reverses identity 20261025180000_ccp_a9_platform_last_owner_invariant: drops the five
-- ccp_a9_platform_last_owner_* triggers and the four identity.ccp_a9_* functions. No row changes.
-- The triggers hold no data. Their dependant is the CCP-A9 subscription role-change apply path
-- (20261025180100), which relies on this invariant, so the compensation is refused (RAISE, nothing
-- changed) while that migration's one-time bootstrap backstop is still installed (run the CCP-A9
-- subscription compensation first). Run with a code revert of A9.
-- Production execution needs separate PO authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF to_regclass('"subscription"."CommercialOperatorAttestation_one_bootstrap_key"') IS NOT NULL THEN
    RAISE EXCEPTION 'CCP-A9 identity compensation refused: the CCP-A9 subscription role-change apply path is still installed (compensate it first)';
  END IF;
END
$$;
DROP TRIGGER "ccp_a9_platform_last_owner_role_delete" ON "identity"."UserTenantMembershipRole";
DROP TRIGGER "ccp_a9_platform_last_owner_role_update" ON "identity"."UserTenantMembershipRole";
DROP TRIGGER "ccp_a9_platform_last_owner_membership_delete" ON "identity"."UserTenantMembership";
DROP TRIGGER "ccp_a9_platform_last_owner_membership_update" ON "identity"."UserTenantMembership";
DROP TRIGGER "ccp_a9_platform_last_owner_user_update" ON "identity"."User";
DROP FUNCTION "identity".ccp_a9_guard_platform_owner_role();
DROP FUNCTION "identity".ccp_a9_guard_platform_owner_membership();
DROP FUNCTION "identity".ccp_a9_guard_platform_owner_user();
DROP FUNCTION "identity".ccp_a9_assert_platform_keeps_owner();
