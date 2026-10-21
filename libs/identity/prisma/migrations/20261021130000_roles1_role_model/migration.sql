-- Aramo-ROLES-1 Implementation Directive v1.0 (LOCKED) §5.2 / §5.3 (ADR-0035 R3, D-1, D-2,
-- D-3, safeguards 1 and S-2) — the organization and product role model reconciliation.
-- ONE guarded, idempotent DO block (precedent 20261020130100_sign_naming_role_scope_keys).
-- It operates on FIXED role row ids and computes every bundle relationally (production
-- carries migration-shipped grants beyond the seed simulation, so no count is assumed):
--   row 0010  tenant_admin -> ats_admin      (ATS administration only)
--   row 02b0  org_admin    -> tenant_admin   (organization administrator)
--   row 0014  tenant_owner                   (organization owner, key unchanged)
--   row 02a0  sign_owner                     (retired: grants reconciled, row deactivated)
--   row 02a1  sign_admin                     (unchanged)
--
-- Steps (all inside the DO block, so a refusal applies NOTHING):
--   0. Guards. No role catalog yet (fresh database, the seed writes the target model) or
--      already applied (row 0010 = ats_admin and row 02b0 = tenant_admin) = no-op.
--      Any other state than (row 0010 = tenant_admin, row 02b0 = org_admin, row 0014 =
--      tenant_owner, row 02a0 = sign_owner, row 02a1 = sign_admin, no ats_admin key) is
--      refused as partial or unexpected.
--      S-2 is evaluated FIRST, on the state before any change. For each ACTIVE or
--      PROVISIONED tenant with zero active tenant_owner (active membership, active user):
--        - rows in identity._roles1_owner_resolution for that tenant: exactly those users
--          become tenant_owner (each must hold an active membership, else refused)
--        - else exactly one active former org_admin membership: it becomes tenant_owner
--        - else more than one: the migration FAILS CLOSED listing the tenant ids
--        - else zero: reported by NOTICE, not changed (an already ownerless tenant, e.g.
--          the PROVISIONED platform sentinel).
--   1. Rename (0010 first, then 02b0) and rewrite the three descriptions (the display name
--      is the leading phrase, the seed upsert never updates an existing row).
--   2. Bundles (INSERT ... ON CONFLICT DO NOTHING / targeted DELETE):
--        tenant_owner += every scope row 02a0 holds except sign:template:use/manage
--        tenant_admin += every scope row 0010 holds (read BEFORE the subtraction) + every
--                        scope row 02a1 holds except sign:billing:manage and sign:template:*
--                        + the eight organization scopes (ORG_ADMIN_SCOPE_KEYS)
--        ats_admin    -= tenant:admin:profile, tenant:admin:domain, tenant:admin:sites,
--                        tenant:admin:user-manage, tenant:admin:settings, audit:read
--                        (keeps auth:session:read and tenant:user:read:directory, F-6)
--   3. D-1: every membership holding row 0010 also gets row 02b0 (audited, reason D1).
--   4. F-4 / S-2 promotions computed in step 0 get row 0014 (audited, reason F4).
--   5. sign_owner holders: with tenant_owner, the grant is deleted. Without tenant_owner,
--      sign_admin is ensured, the grant is deleted and they are listed by NOTICE for an
--      explicit PO ownership decision (never auto-promoted, safeguard 1). Every grant and
--      removal is audited (reason SIGN_OWNER). Then row 02a0 is set is_active = false.
--      Removing sign_owner grants never trips the ROLES-1 PR-1 last-owner trigger (it
--      counts only the tenant_owner key).
--   6. AuthorizationVersion bump (authorization-version.ops.ts bump semantics: absent row
--      -> 2, present -> +1) for every principal whose effective scope set changed (the
--      before/after (tenant, user, scope) sets over active roles are diffed).
-- Audit rows: identity.IdentityAuditEvent, actor_type system, actor_id = the system
-- ServiceAccount (seed SEED_IDS.service_account_system), event types
-- ROLES1_RECONCILE_GRANT / ROLES1_RECONCILE_REVOKE, payload reason + role_key + tenant_id +
-- user_id + membership_id. Deterministic ids (md5 of a stable key cast to uuid): the new
-- RoleScope rows use md5(roles1 + role id + scope id), the same id the seed derives
-- (roles1RoleScopeId in libs/identity/prisma/seed.ts).
--
-- Operator note (S-2): identity._roles1_owner_resolution is created empty here. An
-- ambiguous tenant makes this migration fail with the tenant ids. Fill the table from the
-- PR-0 inventory evidence (one row per intended owner) and re-run. Because a failed run
-- also rolls back this CREATE, the table may be created ahead of the run with this same
-- statement.
-- splitDdl-safe: no semicolons and no double hyphens inside the single-quoted DO body, no
-- statement terminator at a line end inside it, and no semicolon in a comment line.

CREATE TABLE IF NOT EXISTS "identity"."_roles1_owner_resolution" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "_roles1_owner_resolution_pkey" PRIMARY KEY ("tenant_id", "user_id")
);

DO '
DECLARE
  c_owner uuid := ''01900000-0000-7000-8000-000000000014''
  ; c_ats uuid := ''01900000-0000-7000-8000-000000000010''
  ; c_org uuid := ''01900000-0000-7000-8000-0000000002b0''
  ; c_sown uuid := ''01900000-0000-7000-8000-0000000002a0''
  ; c_sadm uuid := ''01900000-0000-7000-8000-0000000002a1''
  ; c_actor uuid := ''01900000-0000-7000-8000-000000000003''
  ; c_mig text := ''20261021130000_roles1_role_model''
  ; k_ats text
  ; k_org text
  ; v_list text
  ; v_n integer
; BEGIN
  SELECT "key" INTO k_ats FROM "identity"."Role" WHERE "id" = c_ats
  ; SELECT "key" INTO k_org FROM "identity"."Role" WHERE "id" = c_org
  ; IF k_ats IS NULL AND k_org IS NULL AND NOT EXISTS (SELECT 1 FROM "identity"."Role" WHERE "key" IN (''org_admin'', ''ats_admin'', ''tenant_admin'')) THEN
    RAISE NOTICE ''roles1: no role catalog yet, nothing to reconcile (the seed writes the ROLES-1 model)''
    ; RETURN
  ; END IF
  ; IF k_ats = ''ats_admin'' AND k_org = ''tenant_admin'' AND NOT EXISTS (SELECT 1 FROM "identity"."Role" WHERE "key" = ''org_admin'') THEN
    RAISE NOTICE ''roles1: already applied, no-op''
    ; RETURN
  ; END IF
  ; IF k_ats IS DISTINCT FROM ''tenant_admin'' OR k_org IS DISTINCT FROM ''org_admin''
     OR EXISTS (SELECT 1 FROM "identity"."Role" WHERE "key" = ''ats_admin'')
     OR (SELECT "key" FROM "identity"."Role" WHERE "id" = c_owner) IS DISTINCT FROM ''tenant_owner''
     OR (SELECT "key" FROM "identity"."Role" WHERE "id" = c_sown) IS DISTINCT FROM ''sign_owner''
     OR (SELECT "key" FROM "identity"."Role" WHERE "id" = c_sadm) IS DISTINCT FROM ''sign_admin'' THEN
    RAISE EXCEPTION ''roles1: partial or unexpected role state refused (row 0010 key %, row 02b0 key %)'', k_ats, k_org
  ; END IF

  ; DROP TABLE IF EXISTS pg_temp."_r1_ex_org"
  ; CREATE TEMP TABLE "_r1_ex_org" ON COMMIT DROP AS
    SELECT m."tenant_id", m."user_id", m."id" AS "membership_id"
    FROM "identity"."UserTenantMembershipRole" r
    JOIN "identity"."UserTenantMembership" m ON m."id" = r."membership_id"
    JOIN "identity"."User" u ON u."id" = m."user_id"
    WHERE r."role_id" = c_org AND m."is_active" AND u."is_active"

  ; DROP TABLE IF EXISTS pg_temp."_r1_ownerless"
  ; CREATE TEMP TABLE "_r1_ownerless" ON COMMIT DROP AS
    SELECT t."id" AS "tenant_id"
    FROM "identity"."Tenant" t
    WHERE t."status" IN (''ACTIVE'', ''PROVISIONED'')
      AND NOT EXISTS (
        SELECT 1 FROM "identity"."UserTenantMembershipRole" r
        JOIN "identity"."UserTenantMembership" m ON m."id" = r."membership_id"
        JOIN "identity"."User" u ON u."id" = m."user_id"
        WHERE m."tenant_id" = t."id" AND m."is_active" AND u."is_active" AND r."role_id" = c_owner)

  ; SELECT string_agg(x."tenant_id"::text || ''/'' || x."user_id"::text, '', '' ORDER BY x."tenant_id", x."user_id") INTO v_list
  FROM "identity"."_roles1_owner_resolution" x
  WHERE x."tenant_id" IN (SELECT "tenant_id" FROM "_r1_ownerless")
    AND NOT EXISTS (
      SELECT 1 FROM "identity"."UserTenantMembership" m
      JOIN "identity"."User" u ON u."id" = m."user_id"
      WHERE m."tenant_id" = x."tenant_id" AND m."user_id" = x."user_id" AND m."is_active" AND u."is_active")
  ; IF v_list IS NOT NULL THEN
    RAISE EXCEPTION ''roles1: owner resolution rows name a user without an active membership in that tenant (tenant/user): %'', v_list
  ; END IF

  ; DROP TABLE IF EXISTS pg_temp."_r1_promote"
  ; CREATE TEMP TABLE "_r1_promote" ON COMMIT DROP AS
    SELECT m."tenant_id", m."user_id", m."id" AS "membership_id", ''resolution_table''::text AS "source"
    FROM "identity"."_roles1_owner_resolution" x
    JOIN "identity"."UserTenantMembership" m ON m."tenant_id" = x."tenant_id" AND m."user_id" = x."user_id"
    WHERE x."tenant_id" IN (SELECT "tenant_id" FROM "_r1_ownerless")
  ; INSERT INTO "_r1_promote" ("tenant_id", "user_id", "membership_id", "source")
    SELECT e."tenant_id", e."user_id", e."membership_id", ''single_former_org_admin''
    FROM "_r1_ex_org" e
    WHERE e."tenant_id" IN (SELECT "tenant_id" FROM "_r1_ownerless")
      AND e."tenant_id" NOT IN (SELECT "tenant_id" FROM "identity"."_roles1_owner_resolution")
      AND (SELECT count(*) FROM "_r1_ex_org" e2 WHERE e2."tenant_id" = e."tenant_id") = 1

  ; SELECT string_agg(a."tenant_id"::text, '', '' ORDER BY a."tenant_id") INTO v_list
  FROM (
    SELECT e."tenant_id" FROM "_r1_ex_org" e
    WHERE e."tenant_id" IN (SELECT "tenant_id" FROM "_r1_ownerless")
      AND e."tenant_id" NOT IN (SELECT "tenant_id" FROM "identity"."_roles1_owner_resolution")
    GROUP BY e."tenant_id" HAVING count(*) > 1) a
  ; IF v_list IS NOT NULL THEN
    RAISE EXCEPTION ''roles1: ambiguous ownerless tenants (more than one former org_admin, no owner resolution rows), nothing applied: %'', v_list
  ; END IF

  ; SELECT string_agg(o."tenant_id"::text, '', '' ORDER BY o."tenant_id") INTO v_list
  FROM "_r1_ownerless" o
  WHERE o."tenant_id" NOT IN (SELECT "tenant_id" FROM "_r1_promote")
  ; IF v_list IS NOT NULL THEN
    RAISE NOTICE ''roles1: ownerless ACTIVE/PROVISIONED tenants with no former org_admin and no resolution rows (reported, not changed): %'', v_list
  ; END IF

  ; DROP TABLE IF EXISTS pg_temp."_r1_eff_before"
  ; CREATE TEMP TABLE "_r1_eff_before" ON COMMIT DROP AS
    SELECT DISTINCT m."tenant_id", m."user_id", rs."scope_id"
    FROM "identity"."UserTenantMembership" m
    JOIN "identity"."UserTenantMembershipRole" r ON r."membership_id" = m."id"
    JOIN "identity"."Role" ro ON ro."id" = r."role_id" AND ro."is_active"
    JOIN "identity"."RoleScope" rs ON rs."role_id" = r."role_id"

  ; UPDATE "identity"."Role" SET "key" = ''ats_admin'', "description" = ''ATS Admin — administers the ATS product (full ATS scope set), with no organization-wide administration'', "updated_at" = now() WHERE "id" = c_ats
  ; UPDATE "identity"."Role" SET "key" = ''tenant_admin'', "description" = ''Tenant Admin — organization administrator: administers the organization and every entitled product and sends Sign envelopes, with no billing and no owner-only acts'', "updated_at" = now() WHERE "id" = c_org
  ; UPDATE "identity"."Role" SET "description" = ''Tenant Owner — organization owner: administers the organization and every entitled product, sends Sign envelopes, and holds the owner-only acts (Sign billing, owner grants, sign-in provider pin)'', "updated_at" = now() WHERE "id" = c_owner

  ; INSERT INTO "identity"."RoleScope" ("id", "role_id", "scope_id")
    SELECT md5(''roles1:'' || c_owner::text || '':'' || rs."scope_id"::text)::uuid, c_owner, rs."scope_id"
    FROM "identity"."RoleScope" rs JOIN "identity"."Scope" s ON s."id" = rs."scope_id"
    WHERE rs."role_id" = c_sown AND s."key" NOT IN (''sign:template:use'', ''sign:template:manage'')
    ON CONFLICT ("role_id", "scope_id") DO NOTHING
  ; INSERT INTO "identity"."RoleScope" ("id", "role_id", "scope_id")
    SELECT md5(''roles1:'' || c_org::text || '':'' || g."scope_id"::text)::uuid, c_org, g."scope_id"
    FROM (
      SELECT rs."scope_id" FROM "identity"."RoleScope" rs WHERE rs."role_id" = c_ats
      UNION
      SELECT rs."scope_id" FROM "identity"."RoleScope" rs JOIN "identity"."Scope" s ON s."id" = rs."scope_id"
      WHERE rs."role_id" = c_sadm AND s."key" NOT IN (''sign:billing:manage'', ''sign:template:use'', ''sign:template:manage'')
      UNION
      SELECT s."id" FROM "identity"."Scope" s
      WHERE s."key" IN (''tenant:admin:profile'', ''tenant:admin:domain'', ''tenant:admin:sites'', ''tenant:admin:user-manage'', ''tenant:admin:settings'', ''tenant:user:read:directory'', ''audit:read'', ''auth:session:read'')
    ) g
    ON CONFLICT ("role_id", "scope_id") DO NOTHING
  ; DELETE FROM "identity"."RoleScope"
    WHERE "role_id" = c_ats
      AND "scope_id" IN (SELECT s."id" FROM "identity"."Scope" s WHERE s."key" IN (''tenant:admin:profile'', ''tenant:admin:domain'', ''tenant:admin:sites'', ''tenant:admin:user-manage'', ''tenant:admin:settings'', ''audit:read''))

  ; WITH ins AS (
    INSERT INTO "identity"."UserTenantMembershipRole" ("id", "membership_id", "role_id")
      SELECT md5(''roles1:utmr:'' || r."membership_id"::text || '':'' || c_org::text)::uuid, r."membership_id", c_org
      FROM "identity"."UserTenantMembershipRole" r WHERE r."role_id" = c_ats
      ON CONFLICT ("membership_id", "role_id") DO NOTHING
      RETURNING "membership_id")
  INSERT INTO "identity"."IdentityAuditEvent" ("id", "tenant_id", "actor_id", "actor_type", "event_type", "subject_id", "event_payload")
    SELECT md5(''roles1:audit:grant:'' || m."id"::text || '':'' || c_org::text)::uuid, m."tenant_id", c_actor, ''system'', ''ROLES1_RECONCILE_GRANT'', m."user_id",
      jsonb_build_object(''reason'', ''D1'', ''role_key'', ''tenant_admin'', ''tenant_id'', m."tenant_id", ''user_id'', m."user_id", ''membership_id'', m."id", ''migration'', c_mig)
    FROM ins JOIN "identity"."UserTenantMembership" m ON m."id" = ins."membership_id"
    ON CONFLICT ("id") DO NOTHING
  ; GET DIAGNOSTICS v_n = ROW_COUNT
  ; RAISE NOTICE ''roles1: D1 tenant_admin grants: %'', v_n

  ; WITH ins AS (
    INSERT INTO "identity"."UserTenantMembershipRole" ("id", "membership_id", "role_id")
      SELECT md5(''roles1:utmr:'' || p."membership_id"::text || '':'' || c_owner::text)::uuid, p."membership_id", c_owner
      FROM "_r1_promote" p
      ON CONFLICT ("membership_id", "role_id") DO NOTHING
      RETURNING "membership_id")
  INSERT INTO "identity"."IdentityAuditEvent" ("id", "tenant_id", "actor_id", "actor_type", "event_type", "subject_id", "event_payload")
    SELECT md5(''roles1:audit:grant:'' || p."membership_id"::text || '':'' || c_owner::text)::uuid, p."tenant_id", c_actor, ''system'', ''ROLES1_RECONCILE_GRANT'', p."user_id",
      jsonb_build_object(''reason'', ''F4'', ''role_key'', ''tenant_owner'', ''tenant_id'', p."tenant_id", ''user_id'', p."user_id", ''membership_id'', p."membership_id", ''source'', p."source", ''migration'', c_mig)
    FROM ins JOIN "_r1_promote" p ON p."membership_id" = ins."membership_id"
    ON CONFLICT ("id") DO NOTHING
  ; GET DIAGNOSTICS v_n = ROW_COUNT
  ; SELECT string_agg(p."tenant_id"::text || ''/'' || p."user_id"::text || '' ('' || p."source" || '')'', '', '' ORDER BY p."tenant_id") INTO v_list FROM "_r1_promote" p
  ; RAISE NOTICE ''roles1: F4 tenant_owner promotions: % [%]'', v_n, coalesce(v_list, ''none'')

  ; DROP TABLE IF EXISTS pg_temp."_r1_sown"
  ; CREATE TEMP TABLE "_r1_sown" ON COMMIT DROP AS
    SELECT r."membership_id", m."tenant_id", m."user_id",
      EXISTS (SELECT 1 FROM "identity"."UserTenantMembershipRole" o WHERE o."membership_id" = r."membership_id" AND o."role_id" = c_owner) AS "has_owner"
    FROM "identity"."UserTenantMembershipRole" r
    JOIN "identity"."UserTenantMembership" m ON m."id" = r."membership_id"
    WHERE r."role_id" = c_sown
  ; WITH ins AS (
    INSERT INTO "identity"."UserTenantMembershipRole" ("id", "membership_id", "role_id")
      SELECT md5(''roles1:utmr:'' || so."membership_id"::text || '':'' || c_sadm::text)::uuid, so."membership_id", c_sadm
      FROM "_r1_sown" so WHERE NOT so."has_owner"
      ON CONFLICT ("membership_id", "role_id") DO NOTHING
      RETURNING "membership_id")
  INSERT INTO "identity"."IdentityAuditEvent" ("id", "tenant_id", "actor_id", "actor_type", "event_type", "subject_id", "event_payload")
    SELECT md5(''roles1:audit:grant:'' || so."membership_id"::text || '':'' || c_sadm::text)::uuid, so."tenant_id", c_actor, ''system'', ''ROLES1_RECONCILE_GRANT'', so."user_id",
      jsonb_build_object(''reason'', ''SIGN_OWNER'', ''role_key'', ''sign_admin'', ''tenant_id'', so."tenant_id", ''user_id'', so."user_id", ''membership_id'', so."membership_id", ''migration'', c_mig)
    FROM ins JOIN "_r1_sown" so ON so."membership_id" = ins."membership_id"
    ON CONFLICT ("id") DO NOTHING
  ; SELECT string_agg(so."tenant_id"::text || ''/'' || so."user_id"::text, '', '' ORDER BY so."tenant_id", so."user_id") INTO v_list FROM "_r1_sown" so WHERE NOT so."has_owner"
  ; IF v_list IS NOT NULL THEN
    RAISE NOTICE ''roles1: sign_owner holders WITHOUT tenant_owner keep Sign authority via sign_admin and need an explicit PO ownership decision (tenant/user): %'', v_list
  ; END IF
  ; WITH del AS (
    DELETE FROM "identity"."UserTenantMembershipRole" r WHERE r."role_id" = c_sown RETURNING r."membership_id")
  INSERT INTO "identity"."IdentityAuditEvent" ("id", "tenant_id", "actor_id", "actor_type", "event_type", "subject_id", "event_payload")
    SELECT md5(''roles1:audit:revoke:'' || so."membership_id"::text || '':'' || c_sown::text)::uuid, so."tenant_id", c_actor, ''system'', ''ROLES1_RECONCILE_REVOKE'', so."user_id",
      jsonb_build_object(''reason'', ''SIGN_OWNER'', ''role_key'', ''sign_owner'', ''tenant_id'', so."tenant_id", ''user_id'', so."user_id", ''membership_id'', so."membership_id", ''held_tenant_owner'', so."has_owner", ''migration'', c_mig)
    FROM del JOIN "_r1_sown" so ON so."membership_id" = del."membership_id"
    ON CONFLICT ("id") DO NOTHING
  ; GET DIAGNOSTICS v_n = ROW_COUNT
  ; RAISE NOTICE ''roles1: sign_owner grants removed: %'', v_n
  ; UPDATE "identity"."Role" SET "is_active" = false, "updated_at" = now() WHERE "id" = c_sown

  ; DROP TABLE IF EXISTS pg_temp."_r1_eff_after"
  ; CREATE TEMP TABLE "_r1_eff_after" ON COMMIT DROP AS
    SELECT DISTINCT m."tenant_id", m."user_id", rs."scope_id"
    FROM "identity"."UserTenantMembership" m
    JOIN "identity"."UserTenantMembershipRole" r ON r."membership_id" = m."id"
    JOIN "identity"."Role" ro ON ro."id" = r."role_id" AND ro."is_active"
    JOIN "identity"."RoleScope" rs ON rs."role_id" = r."role_id"
  ; INSERT INTO "identity"."AuthorizationVersion" ("id", "tenant_id", "principal_id", "version", "updated_at")
    SELECT md5(''roles1:authz:'' || c."tenant_id"::text || '':'' || c."user_id"::text)::uuid, c."tenant_id", c."user_id", 2, now()
    FROM (
      SELECT d."tenant_id", d."user_id" FROM (
        (SELECT * FROM "_r1_eff_before" EXCEPT SELECT * FROM "_r1_eff_after")
        UNION
        (SELECT * FROM "_r1_eff_after" EXCEPT SELECT * FROM "_r1_eff_before")) d
      GROUP BY d."tenant_id", d."user_id") c
    ON CONFLICT ("tenant_id", "principal_id") DO UPDATE SET "version" = "identity"."AuthorizationVersion"."version" + 1, "updated_at" = now()
  ; GET DIAGNOSTICS v_n = ROW_COUNT
  ; RAISE NOTICE ''roles1: authorization versions bumped: %'', v_n
; END
';
