-- Aramo-ATS-QA-1 Package 1 Implementation Directive v1.0 (LOCKED) §4 I-2; conforming
-- amendment A4 (supersedes TI-1D-D Scope-Grant Amendment §2 :26-31 grant set).
-- ONE guarded, idempotent DO block on FIXED ids (ORG-UX-1 20261022140000 precedent):
--   scope   pipeline:resume:set ENSURED on its seed id 0x0077 (I-0 finding F-1: the row was
--           seed-only and is absent on databases the seed never reached, e.g. production)
--   grants  the full ratified set — TI-1D-D: ats_admin, tenant_owner, recruiter,
--           account_manager (seed ids 0x1200..0x1203), tenant_admin (ROLES-1 derived id),
--           plus A4: lead_recruiter, recruiting_manager, sourcer (md5 ats-qa-1 ids)
-- Steps (inside the DO block, so a refusal applies NOTHING):
--   0. Guards. No role catalog yet = no-op (the seed writes the target model). Any role
--      row not carrying its expected key is refused.
--   1. Scope row ensured (INSERT ... ON CONFLICT (key) DO NOTHING), description byte-identical
--      to the seed's (chr(59) stands in for its semicolons).
--   2. Effective (tenant, user, scope) set before.
--   3. Grants: INSERT ... ON CONFLICT (role_id, scope_id) DO NOTHING (existing ids kept).
--   4. AuthorizationVersion bump for every principal whose effective set changed.
-- Idempotent: a re-run inserts nothing and bumps nobody.
-- splitDdl-safe: no semicolons and no double hyphens inside the single-quoted DO body, no
-- statement terminator at a line end inside it, and no semicolon in a comment line.

DO '
DECLARE
  c_ats uuid := ''01900000-0000-7000-8000-000000000010''
  ; c_rec uuid := ''01900000-0000-7000-8000-000000000011''
  ; c_owner uuid := ''01900000-0000-7000-8000-000000000014''
  ; c_am uuid := ''01900000-0000-7000-8000-000000000016''
  ; c_rm uuid := ''01900000-0000-7000-8000-000000000017''
  ; c_src uuid := ''01900000-0000-7000-8000-000000000018''
  ; c_lr uuid := ''01900000-0000-7000-8000-000000000019''
  ; c_org uuid := ''01900000-0000-7000-8000-0000000002b0''
  ; s_rs uuid
  ; v_n integer
; BEGIN
  IF NOT EXISTS (SELECT 1 FROM "identity"."Role" WHERE "id" IN (c_ats, c_rec, c_owner, c_am, c_rm, c_src, c_lr, c_org)) THEN
    RAISE NOTICE ''ats_qa_1: no role catalog yet, nothing to grant (the seed writes the model)''
    ; RETURN
  ; END IF
  ; IF (SELECT "key" FROM "identity"."Role" WHERE "id" = c_ats) IS DISTINCT FROM ''ats_admin''
     OR (SELECT "key" FROM "identity"."Role" WHERE "id" = c_rec) IS DISTINCT FROM ''recruiter''
     OR (SELECT "key" FROM "identity"."Role" WHERE "id" = c_owner) IS DISTINCT FROM ''tenant_owner''
     OR (SELECT "key" FROM "identity"."Role" WHERE "id" = c_am) IS DISTINCT FROM ''account_manager''
     OR (SELECT "key" FROM "identity"."Role" WHERE "id" = c_rm) IS DISTINCT FROM ''recruiting_manager''
     OR (SELECT "key" FROM "identity"."Role" WHERE "id" = c_src) IS DISTINCT FROM ''sourcer''
     OR (SELECT "key" FROM "identity"."Role" WHERE "id" = c_lr) IS DISTINCT FROM ''lead_recruiter''
     OR (SELECT "key" FROM "identity"."Role" WHERE "id" = c_org) IS DISTINCT FROM ''tenant_admin'' THEN
    RAISE EXCEPTION ''ats_qa_1: unexpected role state refused (ROLES-1 PR-2 role model required)''
  ; END IF

  ; INSERT INTO "identity"."Scope" ("id", "key", "description")
    VALUES (''01900000-0000-7000-8000-000000000077'', ''pipeline:resume:set'', ''TI-1D-D — set the Requisition-context resume selection for a pipeline (PUT /v1/pipelines/{id}/resume-edition'' || chr(59) || '' appends a TalentRequisitionResume working-selection row, never mutates prior). DEDICATED mutation scope'' || chr(59) || '' GRANTED to the four pipeline:change-status holders (recruiter, account_manager, tenant_admin, tenant_owner) via RESUME_SELECT_SEED_BUNDLES as an EXPLICIT TI-1D-D decision — NOT auto-inherited from pipeline:change-status and NOT a reuse of it (the dedicated scope preserves the lifecycle-vs-selection distinction). NO scope.created (scope-seed precedent).'')
    ON CONFLICT ("key") DO NOTHING
  ; SELECT "id" INTO s_rs FROM "identity"."Scope" WHERE "key" = ''pipeline:resume:set''

  ; DROP TABLE IF EXISTS pg_temp."_qa1_eff_before"
  ; CREATE TEMP TABLE "_qa1_eff_before" ON COMMIT DROP AS
    SELECT DISTINCT m."tenant_id", m."user_id", rs."scope_id"
    FROM "identity"."UserTenantMembership" m
    JOIN "identity"."UserTenantMembershipRole" r ON r."membership_id" = m."id"
    JOIN "identity"."Role" ro ON ro."id" = r."role_id" AND ro."is_active"
    JOIN "identity"."RoleScope" rs ON rs."role_id" = r."role_id"

  ; INSERT INTO "identity"."RoleScope" ("id", "role_id", "scope_id")
    SELECT g."id", g."role_id", s_rs
    FROM (VALUES
      (''01900000-0000-7000-8000-000000001200''::uuid, c_ats),
      (''01900000-0000-7000-8000-000000001201''::uuid, c_owner),
      (''01900000-0000-7000-8000-000000001202''::uuid, c_rec),
      (''01900000-0000-7000-8000-000000001203''::uuid, c_am),
      (md5(''roles1:'' || c_org::text || '':'' || s_rs::text)::uuid, c_org),
      (md5(''ats-qa-1:'' || c_lr::text || '':'' || s_rs::text)::uuid, c_lr),
      (md5(''ats-qa-1:'' || c_rm::text || '':'' || s_rs::text)::uuid, c_rm),
      (md5(''ats-qa-1:'' || c_src::text || '':'' || s_rs::text)::uuid, c_src)
    ) AS g ("id", "role_id")
    ON CONFLICT ("role_id", "scope_id") DO NOTHING
  ; GET DIAGNOSTICS v_n = ROW_COUNT
  ; RAISE NOTICE ''ats_qa_1: pipeline:resume:set grants inserted: %'', v_n

  ; DROP TABLE IF EXISTS pg_temp."_qa1_eff_after"
  ; CREATE TEMP TABLE "_qa1_eff_after" ON COMMIT DROP AS
    SELECT DISTINCT m."tenant_id", m."user_id", rs."scope_id"
    FROM "identity"."UserTenantMembership" m
    JOIN "identity"."UserTenantMembershipRole" r ON r."membership_id" = m."id"
    JOIN "identity"."Role" ro ON ro."id" = r."role_id" AND ro."is_active"
    JOIN "identity"."RoleScope" rs ON rs."role_id" = r."role_id"
  ; INSERT INTO "identity"."AuthorizationVersion" ("id", "tenant_id", "principal_id", "version", "updated_at")
    SELECT md5(''ats-qa-1:authz:'' || c."tenant_id"::text || '':'' || c."user_id"::text)::uuid, c."tenant_id", c."user_id", 2, now()
    FROM (
      SELECT d."tenant_id", d."user_id" FROM (
        (SELECT * FROM "_qa1_eff_before" EXCEPT SELECT * FROM "_qa1_eff_after")
        UNION
        (SELECT * FROM "_qa1_eff_after" EXCEPT SELECT * FROM "_qa1_eff_before")) d
      GROUP BY d."tenant_id", d."user_id") c
    ON CONFLICT ("tenant_id", "principal_id") DO UPDATE SET "version" = "identity"."AuthorizationVersion"."version" + 1, "updated_at" = now()
  ; GET DIAGNOSTICS v_n = ROW_COUNT
  ; RAISE NOTICE ''ats_qa_1: authorization versions bumped: %'', v_n
; END
';
