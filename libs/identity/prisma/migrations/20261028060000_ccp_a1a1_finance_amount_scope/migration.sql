-- Aramo-CCP-A1-Amendment-A1-Finance-Amount-Scope-v1_0 (LOCKED 2026-10-25) FA-1, FA-2, FA-7, FA-8.
-- ONE guarded, idempotent, fail-closed DO block on FIXED ids (the CCP-A1 20261024120000 pattern):
--   scope   platform:billing:amount:read on 0x335 (seed-identical text)
--   grants  exactly 3 rows: platform_owner (0x2c0), finance_admin (0x2c1), read_only_auditor
--           (0x2c5), ids md5(ccp-a1a1:role_id:scope_id)
-- Totals: CCP-A1-A1 +1 scope / +3 grants, 25 / 206 / 987 (roles unchanged).
-- Steps (inside the DO block, so a refusal applies NOTHING):
--   0. No role catalog yet = no-op (the seed writes the model).
--   1. Fail closed. The 3 holder roles must exist on their fixed ids with their keys (CCP-A1
--      applied). The scope id holding a different key, or the scope key on a different id, is
--      refused with no fallback id.
--   2. Effective (tenant, user, scope) set before.
--   3. The Scope row and the 3 RoleScope rows ensured (ON CONFLICT DO NOTHING), then verified:
--      the description is seed-identical and EXACTLY the 3 holder roles hold the scope (FA-2).
--   4. AuthorizationVersion bump for every principal whose effective set changed (a holder of
--      one of the 3 roles gains the scope, so its cached authorization is invalidated).
-- Idempotent: a re-run inserts nothing and bumps nobody.
-- splitDdl-safe: no semicolons and no double hyphens inside the single-quoted DO body, no
-- statement terminator at a line end inside it, and no semicolon in a comment line.
-- Compensation (FA-8, documented, not shipped: libs/identity/src/tests/fixtures/
-- ccp-a1a1-compensating.sql): refuse while any role other than the 3 grantees holds the scope,
-- then delete the 3 RoleScope rows and the Scope row (and bump the affected principals).

DO '
DECLARE
  c_scope uuid := ''01900000-0000-7000-8000-000000000335''
  ; c_key text := ''platform:billing:amount:read''
  ; c_desc text := ''Platform-tier CCP: read tenant-specific monetary figures, invoice, payment, credit and revenue amounts, in addition to platform:billing:read (enforced from CCP-A1 Amendment A1)''
  ; v_scopes integer
  ; v_grants integer
  ; v_n integer
; BEGIN
  IF NOT EXISTS (SELECT 1 FROM "identity"."Role") THEN
    RAISE NOTICE ''ccp_a1a1: no role catalog yet, nothing to apply (the seed writes the model)''
    ; RETURN
  ; END IF

  ; DROP TABLE IF EXISTS pg_temp."_ccp_a1a1_holder"
  ; CREATE TEMP TABLE "_ccp_a1a1_holder" ON COMMIT DROP AS
    SELECT * FROM (VALUES
      (''01900000-0000-7000-8000-0000000002c0''::uuid, ''platform_owner''),
      (''01900000-0000-7000-8000-0000000002c1''::uuid, ''finance_admin''),
      (''01900000-0000-7000-8000-0000000002c5''::uuid, ''read_only_auditor'')
    ) AS t ("id", "key")

  ; IF (SELECT count(*) FROM "_ccp_a1a1_holder" t JOIN "identity"."Role" r ON r."id" = t."id" AND r."key" = t."key") <> 3 THEN
    RAISE EXCEPTION ''ccp_a1a1: the 3 holder roles are not on their fixed ids (CCP-A1 must precede), refused''
  ; END IF
  ; IF EXISTS (SELECT 1 FROM "identity"."Scope" s WHERE s."id" = c_scope AND s."key" IS DISTINCT FROM c_key)
     OR EXISTS (SELECT 1 FROM "identity"."Scope" s WHERE s."key" = c_key AND s."id" IS DISTINCT FROM c_scope) THEN
    RAISE EXCEPTION ''ccp_a1a1: scope id/key conflict refused (fixed id only, no fallback)''
  ; END IF

  ; DROP TABLE IF EXISTS pg_temp."_ccp_a1a1_eff_before"
  ; CREATE TEMP TABLE "_ccp_a1a1_eff_before" ON COMMIT DROP AS
    SELECT DISTINCT m."tenant_id", m."user_id", rs."scope_id"
    FROM "identity"."UserTenantMembership" m
    JOIN "identity"."UserTenantMembershipRole" r ON r."membership_id" = m."id"
    JOIN "identity"."Role" ro ON ro."id" = r."role_id" AND ro."is_active"
    JOIN "identity"."RoleScope" rs ON rs."role_id" = r."role_id"

  ; INSERT INTO "identity"."Scope" ("id", "key", "description")
    VALUES (c_scope, c_key, c_desc)
    ON CONFLICT ("id") DO NOTHING
  ; GET DIAGNOSTICS v_scopes = ROW_COUNT
  ; INSERT INTO "identity"."RoleScope" ("id", "role_id", "scope_id")
    SELECT md5(''ccp-a1a1:'' || h."id"::text || '':'' || c_scope::text)::uuid, h."id", c_scope
    FROM "_ccp_a1a1_holder" h
    ON CONFLICT ("role_id", "scope_id") DO NOTHING
  ; GET DIAGNOSTICS v_grants = ROW_COUNT

  ; IF NOT EXISTS (SELECT 1 FROM "identity"."Scope" s WHERE s."id" = c_scope AND s."key" = c_key AND s."description" = c_desc) THEN
    RAISE EXCEPTION ''ccp_a1a1: scope row differs from the seed definition, refused''
  ; END IF
  ; IF EXISTS (SELECT rs."role_id" FROM "identity"."RoleScope" rs WHERE rs."scope_id" = c_scope
               EXCEPT SELECT h."id" FROM "_ccp_a1a1_holder" h)
     OR (SELECT count(*) FROM "identity"."RoleScope" rs WHERE rs."scope_id" = c_scope) <> 3 THEN
    RAISE EXCEPTION ''ccp_a1a1: the holders of platform:billing:amount:read differ from FA-2 (exactly 3 roles), refused''
  ; END IF

  ; DROP TABLE IF EXISTS pg_temp."_ccp_a1a1_eff_after"
  ; CREATE TEMP TABLE "_ccp_a1a1_eff_after" ON COMMIT DROP AS
    SELECT DISTINCT m."tenant_id", m."user_id", rs."scope_id"
    FROM "identity"."UserTenantMembership" m
    JOIN "identity"."UserTenantMembershipRole" r ON r."membership_id" = m."id"
    JOIN "identity"."Role" ro ON ro."id" = r."role_id" AND ro."is_active"
    JOIN "identity"."RoleScope" rs ON rs."role_id" = r."role_id"
  ; INSERT INTO "identity"."AuthorizationVersion" ("id", "tenant_id", "principal_id", "version", "updated_at")
    SELECT md5(''ccp-a1a1:authz:'' || c."tenant_id"::text || '':'' || c."user_id"::text)::uuid, c."tenant_id", c."user_id", 2, now()
    FROM (
      SELECT d."tenant_id", d."user_id" FROM (
        (SELECT * FROM "_ccp_a1a1_eff_before" EXCEPT SELECT * FROM "_ccp_a1a1_eff_after")
        UNION
        (SELECT * FROM "_ccp_a1a1_eff_after" EXCEPT SELECT * FROM "_ccp_a1a1_eff_before")) d
      GROUP BY d."tenant_id", d."user_id") c
    ON CONFLICT ("tenant_id", "principal_id") DO UPDATE SET "version" = "identity"."AuthorizationVersion"."version" + 1, "updated_at" = now()
  ; GET DIAGNOSTICS v_n = ROW_COUNT

  ; RAISE NOTICE ''ccp_a1a1: scopes inserted: %, grants inserted: %, authorization versions bumped: %'', v_scopes, v_grants, v_n
; END
';
