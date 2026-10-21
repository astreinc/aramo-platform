-- Aramo-DOC-TEMPLATE-LIB-1 Implementation Directive v1.0 (LOCKED) §6.3 (ADR-0034 D11, O-3)
-- T-4 — document template grants move to the organization roles.
-- ONE guarded, idempotent DO block on FIXED role row ids (ROLES-1 PR-2 precedent
-- 20261021130000_roles1_role_model):
--   row 0010  ats_admin     -= document_template:manage   (template administration left ATS)
--   row 02b0  tenant_admin  += document_template:read, document_template:manage (ensured)
--   row 0014  tenant_owner  += document_template:read, document_template:manage (ensured)
--   row 02a1  sign_admin    += document_template:read     (Sign starts envelopes from templates)
--   row 02a2  sign_sender   += document_template:read
-- document_template:read stays with ats_admin, recruiter and account_manager (F-9). The
-- sign:template:* pair is NOT touched here (removed by T-5).
--
-- Steps (all inside the DO block, so a refusal applies NOTHING):
--   0. Guards. No role catalog or no document_template scopes yet (fresh database, the
--      seed writes the target model) = no-op. Any role row not carrying its expected key
--      (for example ROLES-1 PR-2 not applied yet) is refused.
--   1. Effective (tenant, user, scope) set over active roles, before.
--   2. Grants: INSERT ... ON CONFLICT DO NOTHING, ids md5(doclib-t4 + role id + scope id)
--      cast to uuid (the same id the seed derives, doclibT4RoleScopeId in
--      libs/identity/prisma/seed.ts). A pair that already exists keeps its id.
--   3. Revoke: the ats_admin x document_template:manage row (its fixed seed id 0x1311 is
--      retired, not reused).
--   4. AuthorizationVersion bump (authorization-version.ops.ts semantics: absent row -> 2,
--      present -> +1) for every principal whose effective scope set changed. Holders of
--      ats_admin together with tenant_admin or tenant_owner keep manage and are not bumped.
-- Idempotent: a re-run inserts and deletes nothing, so no effective set changes and no
-- version is bumped.
-- splitDdl-safe: no semicolons and no double hyphens inside the single-quoted DO body, no
-- statement terminator at a line end inside it, and no semicolon in a comment line.

DO '
DECLARE
  c_owner uuid := ''01900000-0000-7000-8000-000000000014''
  ; c_ats uuid := ''01900000-0000-7000-8000-000000000010''
  ; c_org uuid := ''01900000-0000-7000-8000-0000000002b0''
  ; c_sadm uuid := ''01900000-0000-7000-8000-0000000002a1''
  ; c_ssnd uuid := ''01900000-0000-7000-8000-0000000002a2''
  ; s_read uuid
  ; s_manage uuid
  ; v_n integer
; BEGIN
  SELECT "id" INTO s_read FROM "identity"."Scope" WHERE "key" = ''document_template:read''
  ; SELECT "id" INTO s_manage FROM "identity"."Scope" WHERE "key" = ''document_template:manage''
  ; IF s_read IS NULL OR s_manage IS NULL OR NOT EXISTS (SELECT 1 FROM "identity"."Role" WHERE "id" IN (c_owner, c_ats, c_org, c_sadm, c_ssnd)) THEN
    RAISE NOTICE ''doclib_t4: no role catalog or template scopes yet, nothing to grant (the seed writes the T-4 model)''
    ; RETURN
  ; END IF
  ; IF (SELECT "key" FROM "identity"."Role" WHERE "id" = c_ats) IS DISTINCT FROM ''ats_admin''
     OR (SELECT "key" FROM "identity"."Role" WHERE "id" = c_org) IS DISTINCT FROM ''tenant_admin''
     OR (SELECT "key" FROM "identity"."Role" WHERE "id" = c_owner) IS DISTINCT FROM ''tenant_owner''
     OR (SELECT "key" FROM "identity"."Role" WHERE "id" = c_sadm) IS DISTINCT FROM ''sign_admin''
     OR (SELECT "key" FROM "identity"."Role" WHERE "id" = c_ssnd) IS DISTINCT FROM ''sign_sender'' THEN
    RAISE EXCEPTION ''doclib_t4: unexpected role state refused (ROLES-1 PR-2 role model required)''
  ; END IF

  ; DROP TABLE IF EXISTS pg_temp."_t4_eff_before"
  ; CREATE TEMP TABLE "_t4_eff_before" ON COMMIT DROP AS
    SELECT DISTINCT m."tenant_id", m."user_id", rs."scope_id"
    FROM "identity"."UserTenantMembership" m
    JOIN "identity"."UserTenantMembershipRole" r ON r."membership_id" = m."id"
    JOIN "identity"."Role" ro ON ro."id" = r."role_id" AND ro."is_active"
    JOIN "identity"."RoleScope" rs ON rs."role_id" = r."role_id"

  ; INSERT INTO "identity"."RoleScope" ("id", "role_id", "scope_id")
    SELECT md5(''doclib-t4:'' || g."role_id"::text || '':'' || g."scope_id"::text)::uuid, g."role_id", g."scope_id"
    FROM (VALUES (c_org, s_read), (c_org, s_manage), (c_owner, s_read), (c_owner, s_manage), (c_sadm, s_read), (c_ssnd, s_read)) AS g ("role_id", "scope_id")
    ON CONFLICT ("role_id", "scope_id") DO NOTHING
  ; GET DIAGNOSTICS v_n = ROW_COUNT
  ; RAISE NOTICE ''doclib_t4: document_template grants inserted: %'', v_n

  ; DELETE FROM "identity"."RoleScope" WHERE "role_id" = c_ats AND "scope_id" = s_manage
  ; GET DIAGNOSTICS v_n = ROW_COUNT
  ; RAISE NOTICE ''doclib_t4: ats_admin document_template:manage grants removed: %'', v_n

  ; DROP TABLE IF EXISTS pg_temp."_t4_eff_after"
  ; CREATE TEMP TABLE "_t4_eff_after" ON COMMIT DROP AS
    SELECT DISTINCT m."tenant_id", m."user_id", rs."scope_id"
    FROM "identity"."UserTenantMembership" m
    JOIN "identity"."UserTenantMembershipRole" r ON r."membership_id" = m."id"
    JOIN "identity"."Role" ro ON ro."id" = r."role_id" AND ro."is_active"
    JOIN "identity"."RoleScope" rs ON rs."role_id" = r."role_id"
  ; INSERT INTO "identity"."AuthorizationVersion" ("id", "tenant_id", "principal_id", "version", "updated_at")
    SELECT md5(''doclib-t4:authz:'' || c."tenant_id"::text || '':'' || c."user_id"::text)::uuid, c."tenant_id", c."user_id", 2, now()
    FROM (
      SELECT d."tenant_id", d."user_id" FROM (
        (SELECT * FROM "_t4_eff_before" EXCEPT SELECT * FROM "_t4_eff_after")
        UNION
        (SELECT * FROM "_t4_eff_after" EXCEPT SELECT * FROM "_t4_eff_before")) d
      GROUP BY d."tenant_id", d."user_id") c
    ON CONFLICT ("tenant_id", "principal_id") DO UPDATE SET "version" = "identity"."AuthorizationVersion"."version" + 1, "updated_at" = now()
  ; GET DIAGNOSTICS v_n = ROW_COUNT
  ; RAISE NOTICE ''doclib_t4: authorization versions bumped: %'', v_n
; END
';
