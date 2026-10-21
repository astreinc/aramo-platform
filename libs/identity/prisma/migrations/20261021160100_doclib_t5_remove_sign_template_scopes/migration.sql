-- Aramo-DOC-TEMPLATE-LIB-1 Implementation Directive v1.0 (LOCKED) §6.4 (ADR-0034 O-3,
-- Conforming Amendment #7) — T-5 removes sign:template:use and sign:template:manage.
-- Templates are Documents-owned; Aramo Sign uses document_template:read (granted by T-4).
-- ONE guarded, idempotent DO block on FIXED ids (T-4 / ROLES-1 PR-2 precedent):
--   Scope 0x140d  sign:template:use
--   Scope 0x140e  sign:template:manage
--   their grants, expected ONLY on the Sign role rows
--     02a0 sign_owner (retired, inactive since ROLES-1, rows kept in existing databases),
--     02a1 sign_admin, 02a2 sign_sender
--   (the seed ids 0x1723/0x1724, 0x172d/0x172e, 0x1734 — deleted by scope, whatever id).
--
-- Steps (all inside the DO block, so a refusal applies NOTHING):
--   0. Guards. Neither scope row present (fresh database, or a re-run) = no-op. A row at a
--      fixed id carrying another key, a template key at another id, or a grant of either
--      scope on any role other than 02a0/02a1/02a2 is refused (listed).
--   1. Effective (tenant, user, scope) set over ACTIVE roles, before.
--   2. Delete the RoleScope rows of both scopes, then the two Scope rows.
--   3. AuthorizationVersion bump (authorization-version.ops.ts semantics: absent row -> 2,
--      present -> +1) for every principal whose effective scope set changed (holders of an
--      ACTIVE sign_admin / sign_sender; the inactive sign_owner contributes nothing).
-- Idempotent: a re-run finds no scope rows and returns before touching anything.
-- splitDdl-safe: no semicolons and no double hyphens inside the single-quoted DO body, no
-- statement terminator at a line end inside it, and no semicolon in a comment line.

DO '
DECLARE
  s_use uuid := ''01900000-0000-7000-8000-00000000140d''
  ; s_manage uuid := ''01900000-0000-7000-8000-00000000140e''
  ; c_sown uuid := ''01900000-0000-7000-8000-0000000002a0''
  ; c_sadm uuid := ''01900000-0000-7000-8000-0000000002a1''
  ; c_ssnd uuid := ''01900000-0000-7000-8000-0000000002a2''
  ; v_bad text
  ; v_n integer
; BEGIN
  IF NOT EXISTS (SELECT 1 FROM "identity"."Scope" WHERE "id" IN (s_use, s_manage) OR "key" IN (''sign:template:use'', ''sign:template:manage'')) THEN
    RAISE NOTICE ''doclib_t5: no sign:template scope rows, nothing to remove''
    ; RETURN
  ; END IF

  ; SELECT string_agg("id"::text || ''='' || "key", '', '') INTO v_bad FROM "identity"."Scope"
    WHERE ("id" IN (s_use, s_manage) OR "key" IN (''sign:template:use'', ''sign:template:manage''))
      AND NOT (("id" = s_use AND "key" = ''sign:template:use'') OR ("id" = s_manage AND "key" = ''sign:template:manage''))
  ; IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION ''doclib_t5: unexpected sign:template scope rows refused: %'', v_bad
  ; END IF

  ; SELECT string_agg(rs."id"::text || '' role '' || rs."role_id"::text, '', '') INTO v_bad FROM "identity"."RoleScope" rs
    WHERE rs."scope_id" IN (s_use, s_manage) AND rs."role_id" NOT IN (c_sown, c_sadm, c_ssnd)
  ; IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION ''doclib_t5: sign:template grants on unexpected roles refused: %'', v_bad
  ; END IF

  ; DROP TABLE IF EXISTS pg_temp."_t5_eff_before"
  ; CREATE TEMP TABLE "_t5_eff_before" ON COMMIT DROP AS
    SELECT DISTINCT m."tenant_id", m."user_id", rs."scope_id"
    FROM "identity"."UserTenantMembership" m
    JOIN "identity"."UserTenantMembershipRole" r ON r."membership_id" = m."id"
    JOIN "identity"."Role" ro ON ro."id" = r."role_id" AND ro."is_active"
    JOIN "identity"."RoleScope" rs ON rs."role_id" = r."role_id"

  ; DELETE FROM "identity"."RoleScope" WHERE "scope_id" IN (s_use, s_manage)
  ; GET DIAGNOSTICS v_n = ROW_COUNT
  ; RAISE NOTICE ''doclib_t5: sign:template grants removed: %'', v_n
  ; DELETE FROM "identity"."Scope" WHERE "id" IN (s_use, s_manage)
  ; GET DIAGNOSTICS v_n = ROW_COUNT
  ; RAISE NOTICE ''doclib_t5: sign:template scopes removed: %'', v_n

  ; DROP TABLE IF EXISTS pg_temp."_t5_eff_after"
  ; CREATE TEMP TABLE "_t5_eff_after" ON COMMIT DROP AS
    SELECT DISTINCT m."tenant_id", m."user_id", rs."scope_id"
    FROM "identity"."UserTenantMembership" m
    JOIN "identity"."UserTenantMembershipRole" r ON r."membership_id" = m."id"
    JOIN "identity"."Role" ro ON ro."id" = r."role_id" AND ro."is_active"
    JOIN "identity"."RoleScope" rs ON rs."role_id" = r."role_id"
  ; INSERT INTO "identity"."AuthorizationVersion" ("id", "tenant_id", "principal_id", "version", "updated_at")
    SELECT md5(''doclib-t5:authz:'' || c."tenant_id"::text || '':'' || c."user_id"::text)::uuid, c."tenant_id", c."user_id", 2, now()
    FROM (
      SELECT d."tenant_id", d."user_id" FROM (
        (SELECT * FROM "_t5_eff_before" EXCEPT SELECT * FROM "_t5_eff_after")
        UNION
        (SELECT * FROM "_t5_eff_after" EXCEPT SELECT * FROM "_t5_eff_before")) d
      GROUP BY d."tenant_id", d."user_id") c
    ON CONFLICT ("tenant_id", "principal_id") DO UPDATE SET "version" = "identity"."AuthorizationVersion"."version" + 1, "updated_at" = now()
  ; GET DIAGNOSTICS v_n = ROW_COUNT
  ; RAISE NOTICE ''doclib_t5: authorization versions bumped: %'', v_n
; END
';
