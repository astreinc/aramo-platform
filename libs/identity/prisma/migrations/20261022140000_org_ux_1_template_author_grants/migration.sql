-- Aramo-ORG-UX-1 Implementation Directive v1.0 (LOCKED) §4.1, §4.2 (P1 Option A)
-- Conforming amendments rows 5, 7, 12.
-- ONE guarded, idempotent DO block on FIXED role row ids (DOC-TEMPLATE-LIB-1 T-4 precedent
-- 20261021150000_doclib_t4_document_template_grants):
--   scope   document_template:author ensured (id 01d9, the seed's SEED_IDS id)
--   row 0014  tenant_owner        += document_template:author
--   row 02b0  tenant_admin        += document_template:author
--   row 0016  account_manager     += document_template:author, -= tenant:admin:user-manage
--   row 0017  recruiting_manager  += document_template:author, -= tenant:admin:user-manage
--   row 0019  lead_recruiter      += document_template:author
-- document_template:manage (approval, selection, withdrawal) is NOT touched: it stays with
-- tenant_owner and tenant_admin.
--
-- Steps (all inside the DO block, so a refusal applies NOTHING):
--   0. Guards. No role catalog yet (fresh database, the seed writes the target model) =
--      no-op. Any role row not carrying its expected key is refused.
--   1. The author scope row is ensured (INSERT ... ON CONFLICT DO NOTHING on the key).
--   2. Effective (tenant, user, scope) set over active roles, before.
--   3. Grants: INSERT ... ON CONFLICT DO NOTHING, ids md5(org-ux-1 + role id + scope id)
--      cast to uuid (orgUx1RoleScopeId in libs/identity/prisma/seed.ts).
--   4. Revoke: account_manager / recruiting_manager x tenant:admin:user-manage (their fixed
--      AUTHZ-1 seed ids are retired, not reused).
--   5. AuthorizationVersion bump (absent row -> 2, present -> +1) for every principal whose
--      effective scope set changed.
-- Idempotent: a re-run inserts and deletes nothing, so no version is bumped.
-- splitDdl-safe: no semicolons and no double hyphens inside the single-quoted DO body, no
-- statement terminator at a line end inside it, and no semicolon in a comment line.

DO '
DECLARE
  c_owner uuid := ''01900000-0000-7000-8000-000000000014''
  ; c_org uuid := ''01900000-0000-7000-8000-0000000002b0''
  ; c_am uuid := ''01900000-0000-7000-8000-000000000016''
  ; c_rm uuid := ''01900000-0000-7000-8000-000000000017''
  ; c_lr uuid := ''01900000-0000-7000-8000-000000000019''
  ; s_author uuid
  ; s_um uuid
  ; v_n integer
; BEGIN
  IF NOT EXISTS (SELECT 1 FROM "identity"."Role" WHERE "id" IN (c_owner, c_org, c_am, c_rm, c_lr)) THEN
    RAISE NOTICE ''org_ux_1: no role catalog yet, nothing to grant (the seed writes the ORG-UX-1 model)''
    ; RETURN
  ; END IF
  ; IF (SELECT "key" FROM "identity"."Role" WHERE "id" = c_owner) IS DISTINCT FROM ''tenant_owner''
     OR (SELECT "key" FROM "identity"."Role" WHERE "id" = c_org) IS DISTINCT FROM ''tenant_admin''
     OR (SELECT "key" FROM "identity"."Role" WHERE "id" = c_am) IS DISTINCT FROM ''account_manager''
     OR (SELECT "key" FROM "identity"."Role" WHERE "id" = c_rm) IS DISTINCT FROM ''recruiting_manager''
     OR (SELECT "key" FROM "identity"."Role" WHERE "id" = c_lr) IS DISTINCT FROM ''lead_recruiter'' THEN
    RAISE EXCEPTION ''org_ux_1: unexpected role state refused (ROLES-1 PR-2 role model required)''
  ; END IF

  ; INSERT INTO "identity"."Scope" ("id", "key", "description")
    VALUES (''01900000-0000-7000-8000-0000000001d9'', ''document_template:author'', ''ORG-UX-1 §4.1 — author tenant document templates: open the Org template pages, browse/preview the Aramo gallery, adopt, create, edit/preview/discard drafts. NOT approval/selection (document_template:manage). Granted to tenant_owner, tenant_admin, account_manager, recruiting_manager, lead_recruiter. NO scope.created (scope-seed precedent).'')
    ON CONFLICT ("key") DO NOTHING
  ; SELECT "id" INTO s_author FROM "identity"."Scope" WHERE "key" = ''document_template:author''
  ; SELECT "id" INTO s_um FROM "identity"."Scope" WHERE "key" = ''tenant:admin:user-manage''

  ; DROP TABLE IF EXISTS pg_temp."_ux1_eff_before"
  ; CREATE TEMP TABLE "_ux1_eff_before" ON COMMIT DROP AS
    SELECT DISTINCT m."tenant_id", m."user_id", rs."scope_id"
    FROM "identity"."UserTenantMembership" m
    JOIN "identity"."UserTenantMembershipRole" r ON r."membership_id" = m."id"
    JOIN "identity"."Role" ro ON ro."id" = r."role_id" AND ro."is_active"
    JOIN "identity"."RoleScope" rs ON rs."role_id" = r."role_id"

  ; INSERT INTO "identity"."RoleScope" ("id", "role_id", "scope_id")
    SELECT md5(''org-ux-1:'' || g."role_id"::text || '':'' || g."scope_id"::text)::uuid, g."role_id", g."scope_id"
    FROM (VALUES (c_owner, s_author), (c_org, s_author), (c_am, s_author), (c_rm, s_author), (c_lr, s_author)) AS g ("role_id", "scope_id")
    ON CONFLICT ("role_id", "scope_id") DO NOTHING
  ; GET DIAGNOSTICS v_n = ROW_COUNT
  ; RAISE NOTICE ''org_ux_1: document_template:author grants inserted: %'', v_n

  ; IF s_um IS NOT NULL THEN
    DELETE FROM "identity"."RoleScope" WHERE "role_id" IN (c_am, c_rm) AND "scope_id" = s_um
    ; GET DIAGNOSTICS v_n = ROW_COUNT
    ; RAISE NOTICE ''org_ux_1: management-tier tenant:admin:user-manage grants removed: %'', v_n
  ; END IF

  ; DROP TABLE IF EXISTS pg_temp."_ux1_eff_after"
  ; CREATE TEMP TABLE "_ux1_eff_after" ON COMMIT DROP AS
    SELECT DISTINCT m."tenant_id", m."user_id", rs."scope_id"
    FROM "identity"."UserTenantMembership" m
    JOIN "identity"."UserTenantMembershipRole" r ON r."membership_id" = m."id"
    JOIN "identity"."Role" ro ON ro."id" = r."role_id" AND ro."is_active"
    JOIN "identity"."RoleScope" rs ON rs."role_id" = r."role_id"
  ; INSERT INTO "identity"."AuthorizationVersion" ("id", "tenant_id", "principal_id", "version", "updated_at")
    SELECT md5(''org-ux-1:authz:'' || c."tenant_id"::text || '':'' || c."user_id"::text)::uuid, c."tenant_id", c."user_id", 2, now()
    FROM (
      SELECT d."tenant_id", d."user_id" FROM (
        (SELECT * FROM "_ux1_eff_before" EXCEPT SELECT * FROM "_ux1_eff_after")
        UNION
        (SELECT * FROM "_ux1_eff_after" EXCEPT SELECT * FROM "_ux1_eff_before")) d
      GROUP BY d."tenant_id", d."user_id") c
    ON CONFLICT ("tenant_id", "principal_id") DO UPDATE SET "version" = "identity"."AuthorizationVersion"."version" + 1, "updated_at" = now()
  ; GET DIAGNOSTICS v_n = ROW_COUNT
  ; RAISE NOTICE ''org_ux_1: authorization versions bumped: %'', v_n
; END
';
