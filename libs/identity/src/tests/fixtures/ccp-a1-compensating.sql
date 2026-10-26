-- CCP-A1 compensating SQL (doc/ccp/slices/CCP-A1-acceptance.md "Compensating SQL"). NOT a forward migration.
-- Reverses 20261024120000_ccp_a1_commercial_role_catalog, as that migration's own header describes:
-- deletes the 45 RoleScope rows, the 15 platform commercial Scope rows and the 6 commercial Role rows
-- (fixed ids 0x2c0..0x2c5 and 0x326..0x334). Refused (RAISE, nothing deleted) while any membership holds
-- one of the 6 roles, or any OTHER role is granted one of the 15 scopes.
-- Run in reverse order: after the compensation of every later CCP migration that uses these roles
-- (CCP-A9 identity 20261025180000 and the subscription chain), and with a code revert of A1.
-- Production execution needs separate PO authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE
  roles uuid[] := ARRAY['01900000-0000-7000-8000-0000000002c0', '01900000-0000-7000-8000-0000000002c1', '01900000-0000-7000-8000-0000000002c2',
                        '01900000-0000-7000-8000-0000000002c3', '01900000-0000-7000-8000-0000000002c4', '01900000-0000-7000-8000-0000000002c5']::uuid[];
  scopes uuid[] := ARRAY(SELECT ('01900000-0000-7000-8000-000000000' || to_hex(n))::uuid FROM generate_series(806, 820) AS n);
BEGIN
  IF EXISTS (SELECT 1 FROM "identity"."UserTenantMembershipRole" WHERE "role_id" = ANY (roles)) THEN
    RAISE EXCEPTION 'CCP-A1 compensation refused: a membership holds a CCP commercial role';
  END IF;
  IF EXISTS (SELECT 1 FROM "identity"."RoleScope" WHERE "scope_id" = ANY (scopes) AND NOT ("role_id" = ANY (roles))) THEN
    RAISE EXCEPTION 'CCP-A1 compensation refused: a non-CCP role is granted a CCP commercial scope';
  END IF;
  DELETE FROM "identity"."RoleScope" WHERE "role_id" = ANY (roles);
  DELETE FROM "identity"."Scope" WHERE "id" = ANY (scopes);
  DELETE FROM "identity"."Role" WHERE "id" = ANY (roles);
END
$$;
