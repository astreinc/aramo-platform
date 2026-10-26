-- CCP-A1 Amendment A2 compensating SQL (PS-5, slice CCP-C8-PR). NOT a forward migration.
-- Reverses 20261028070000_ccp_a1a2_payment_request_scope: deletes the 2 RoleScope rows and the Scope row
-- platform:payment:request (fixed id 0x336). Refused (RAISE, nothing deleted) while any role OTHER than
-- the 2 grantees (finance_admin 0x2c1, commercial_ops 0x2c2) holds the scope.
-- Bumps the AuthorizationVersion of every principal holding one of the 2 roles (their effective set shrinks).
-- Run BEFORE the CCP-A1 Amendment A1 compensation (ccp-a1a1-compensating.sql), and so before the CCP-A1
-- compensation (ccp-a1-compensating.sql), with a code revert of the amendment.
-- Production execution needs separate PO authorization (A0-C15).
-- splitDdl-safe: no semicolons in comment lines.
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE
  holders uuid[] := ARRAY['01900000-0000-7000-8000-0000000002c1', '01900000-0000-7000-8000-0000000002c2']::uuid[];
  c_scope uuid := '01900000-0000-7000-8000-000000000336';
BEGIN
  IF EXISTS (SELECT 1 FROM "identity"."RoleScope" WHERE "scope_id" = c_scope AND NOT ("role_id" = ANY (holders))) THEN
    RAISE EXCEPTION 'CCP-A1-A2 compensation refused: a role other than the 2 grantees holds platform:payment:request';
  END IF;
  INSERT INTO "identity"."AuthorizationVersion" ("id", "tenant_id", "principal_id", "version", "updated_at")
    SELECT md5('ccp-a1a2:authz:' || m."tenant_id"::text || ':' || m."user_id"::text)::uuid, m."tenant_id", m."user_id", 2, now()
      FROM (SELECT DISTINCT m."tenant_id", m."user_id" FROM "identity"."UserTenantMembership" m
              JOIN "identity"."UserTenantMembershipRole" r ON r."membership_id" = m."id"
             WHERE r."role_id" = ANY (holders)) m
    ON CONFLICT ("tenant_id", "principal_id") DO UPDATE SET "version" = "identity"."AuthorizationVersion"."version" + 1, "updated_at" = now();
  DELETE FROM "identity"."RoleScope" WHERE "scope_id" = c_scope AND "role_id" = ANY (holders);
  DELETE FROM "identity"."Scope" WHERE "id" = c_scope;
END
$$;
