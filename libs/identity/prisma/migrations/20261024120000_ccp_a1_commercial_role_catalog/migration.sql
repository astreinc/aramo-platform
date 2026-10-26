-- Aramo-CCP-A1-Commercial-Roles-and-Scopes-Directive-v1_0 (LOCKED) §6.4, under
-- Aramo-CCP-Program-Build-Directive-v1_0 (LOCKED). CCP A1 commercial role catalog, catalog only.
-- ONE guarded, idempotent, fail-closed DO block on FIXED ids (ATS-QA-1 20261022150000 and
-- ORG-UX-1 20261022140000 precedent):
--   roles   6 platform-tier commercial roles on 0x2c0..0x2c5 (is_active, seed-identical text)
--   scopes  15 platform:* commercial scopes on 0x326..0x334 (seed-identical text)
--   grants  the 45 role-scope rows of CCP_PLATFORM_ROLE_SEED_BUNDLES (39 commercial plus
--           platform:tenant:read for each of the 6 roles), ids md5(ccp-a1:role_id:scope_id)
-- No user is granted any of the 6 roles here (ruling A0-C1). super_admin is untouched.
-- Steps (inside the DO block, so a refusal applies NOTHING):
--   0. No role catalog yet = no-op (the seed writes the model).
--   1. Fail closed. A target id holding a different key, or a target key on a different id,
--      is refused with no fallback id. platform:tenant:read must exist.
--   2. Effective (tenant, user, scope) set before.
--   3. Role, Scope and RoleScope rows ensured (ON CONFLICT DO NOTHING, existing ids kept),
--      then verified: text and is_active seed-identical, each CCP role holds exactly its bundle.
--   4. Effective set after. The AuthorizationVersion bump set MUST be empty (no membership
--      holds a new role), otherwise the block RAISEs. Nothing is bumped.
-- Idempotent: a re-run inserts nothing and bumps nobody.
-- splitDdl-safe: no semicolons and no double hyphens inside the single-quoted DO body, no
-- statement terminator at a line end inside it, and no semicolon in a comment line.
-- CCP-R3 (Aramo-CCP-A1-Amendment-A1-Finance-Amount-Scope-v1_0 LOCKED): the bundle check covers the
-- A1 scope set (the 15 commercial scopes and platform:tenant:read) only, so a successor amendment's
-- grant (20261028060000 platform:billing:amount:read) does not make a re-run refuse. Edited in
-- place: no CCP migration is deployed (the CCP-D1-R precedent), recorded in CCP-R3-acceptance.
-- Rollback (schedule §10.4): a compensating migration deleting the 45 RoleScope rows, the 15
-- Scope rows and the 6 Role rows, guarded to RAISE if any membership references a new role.

DO '
DECLARE
  c_tr uuid
  ; v_roles integer
  ; v_scopes integer
  ; v_grants integer
  ; v_n integer
; BEGIN
  IF NOT EXISTS (SELECT 1 FROM "identity"."Role") THEN
    RAISE NOTICE ''ccp_a1: no role catalog yet, nothing to apply (the seed writes the model)''
    ; RETURN
  ; END IF

  ; DROP TABLE IF EXISTS pg_temp."_ccp_a1_role"
  ; CREATE TEMP TABLE "_ccp_a1_role" ON COMMIT DROP AS
    SELECT * FROM (VALUES
      (''01900000-0000-7000-8000-0000000002c0''::uuid, ''platform_owner'', ''Platform Owner — CCP final approver: approves and publishes catalog versions'' || chr(59) || '' approves subscription, entitlement and billing changes. Platform tier'' || chr(59) || '' platform:* scopes only.''),
      (''01900000-0000-7000-8000-0000000002c1''::uuid, ''finance_admin'', ''Finance Admin — CCP financial approver for catalog, subscription, entitlement and billing changes'' || chr(59) || '' reads the commercial audit. Platform tier'' || chr(59) || '' platform:* scopes only.''),
      (''01900000-0000-7000-8000-0000000002c2''::uuid, ''commercial_ops'', ''Commercial Ops — CCP requester for subscription, entitlement and billing changes'' || chr(59) || '' never approves. Platform tier'' || chr(59) || '' platform:* scopes only.''),
      (''01900000-0000-7000-8000-0000000002c3''::uuid, ''catalog_manager'', ''Catalog Manager — CCP catalog author: drafts catalog versions'' || chr(59) || '' never approves or publishes. Platform tier'' || chr(59) || '' platform:* scopes only.''),
      (''01900000-0000-7000-8000-0000000002c4''::uuid, ''support_admin'', ''Support Admin — CCP support: applies bounded support exceptions under the active commercial policy'' || chr(59) || '' reads subscriptions and billing status. Platform tier'' || chr(59) || '' platform:* scopes only.''),
      (''01900000-0000-7000-8000-0000000002c5''::uuid, ''read_only_auditor'', ''Read-only Auditor — CCP read access to catalog, subscriptions, billing status, approvals and the commercial audit. No write. Platform tier'' || chr(59) || '' platform:* scopes only.'')
    ) AS t ("id", "key", "description")
  ; DROP TABLE IF EXISTS pg_temp."_ccp_a1_scope"
  ; CREATE TEMP TABLE "_ccp_a1_scope" ON COMMIT DROP AS
    SELECT * FROM (VALUES
      (''01900000-0000-7000-8000-000000000326''::uuid, ''platform:catalog:read'', ''Platform-tier CCP: read catalog products, plans and plan versions (enforced from CCP A3 + A5)''),
      (''01900000-0000-7000-8000-000000000327''::uuid, ''platform:catalog:draft'', ''Platform-tier CCP: draft a catalog version change request (enforced from CCP A3 + A5)''),
      (''01900000-0000-7000-8000-000000000328''::uuid, ''platform:catalog:approve'', ''Platform-tier CCP: approve a catalog version change request (enforced from CCP A3 + A5)''),
      (''01900000-0000-7000-8000-000000000329''::uuid, ''platform:catalog:publish'', ''Platform-tier CCP: publish an approved catalog version (enforced from CCP A3 + A5)''),
      (''01900000-0000-7000-8000-00000000032a''::uuid, ''platform:subscription:read'', ''Platform-tier CCP: read tenant subscriptions across products (enforced from CCP A3 + A6)''),
      (''01900000-0000-7000-8000-00000000032b''::uuid, ''platform:subscription:request'', ''Platform-tier CCP: request a subscription change (enforced from CCP A3 + A6)''),
      (''01900000-0000-7000-8000-00000000032c''::uuid, ''platform:subscription:approve'', ''Platform-tier CCP: approve a subscription change request (enforced from CCP A3 + A6)''),
      (''01900000-0000-7000-8000-00000000032d''::uuid, ''platform:subscription:support'', ''Platform-tier CCP: apply a bounded support exception to a subscription (enforced from CCP A8)''),
      (''01900000-0000-7000-8000-00000000032e''::uuid, ''platform:entitlement:request'', ''Platform-tier CCP: request a product entitlement grant or revoke (enforced from CCP A6 + A7)''),
      (''01900000-0000-7000-8000-00000000032f''::uuid, ''platform:entitlement:approve'', ''Platform-tier CCP: approve a product entitlement change request (enforced from CCP A6 + A7)''),
      (''01900000-0000-7000-8000-000000000330''::uuid, ''platform:billing:read'', ''Platform-tier CCP: read billing status, invoices and payments (enforced from CCP C3 + C4)''),
      (''01900000-0000-7000-8000-000000000331''::uuid, ''platform:billing:request'', ''Platform-tier CCP: request a billing change such as a credit, refund or discount (enforced from CCP C3 + C4)''),
      (''01900000-0000-7000-8000-000000000332''::uuid, ''platform:billing:approve'', ''Platform-tier CCP: approve a billing change request (enforced from CCP C3 + C4)''),
      (''01900000-0000-7000-8000-000000000333''::uuid, ''platform:approval:read'', ''Platform-tier CCP: read commercial change requests and their approvals (enforced from CCP A3)''),
      (''01900000-0000-7000-8000-000000000334''::uuid, ''platform:commercial:audit:read'', ''Platform-tier CCP: read the commercial audit trail (enforced from CCP A2)'')
    ) AS t ("id", "key", "description")
  ; DROP TABLE IF EXISTS pg_temp."_ccp_a1_grant"
  ; CREATE TEMP TABLE "_ccp_a1_grant" ON COMMIT DROP AS
    SELECT * FROM (VALUES
      (''platform_owner'', ''platform:tenant:read''),
      (''platform_owner'', ''platform:catalog:read''),
      (''platform_owner'', ''platform:catalog:approve''),
      (''platform_owner'', ''platform:catalog:publish''),
      (''platform_owner'', ''platform:subscription:read''),
      (''platform_owner'', ''platform:subscription:approve''),
      (''platform_owner'', ''platform:entitlement:approve''),
      (''platform_owner'', ''platform:billing:read''),
      (''platform_owner'', ''platform:billing:approve''),
      (''platform_owner'', ''platform:approval:read''),
      (''platform_owner'', ''platform:commercial:audit:read''),
      (''finance_admin'', ''platform:tenant:read''),
      (''finance_admin'', ''platform:catalog:read''),
      (''finance_admin'', ''platform:catalog:approve''),
      (''finance_admin'', ''platform:subscription:read''),
      (''finance_admin'', ''platform:subscription:approve''),
      (''finance_admin'', ''platform:entitlement:approve''),
      (''finance_admin'', ''platform:billing:read''),
      (''finance_admin'', ''platform:billing:approve''),
      (''finance_admin'', ''platform:approval:read''),
      (''finance_admin'', ''platform:commercial:audit:read''),
      (''commercial_ops'', ''platform:tenant:read''),
      (''commercial_ops'', ''platform:catalog:read''),
      (''commercial_ops'', ''platform:subscription:read''),
      (''commercial_ops'', ''platform:subscription:request''),
      (''commercial_ops'', ''platform:entitlement:request''),
      (''commercial_ops'', ''platform:billing:read''),
      (''commercial_ops'', ''platform:billing:request''),
      (''commercial_ops'', ''platform:approval:read''),
      (''catalog_manager'', ''platform:tenant:read''),
      (''catalog_manager'', ''platform:catalog:read''),
      (''catalog_manager'', ''platform:catalog:draft''),
      (''catalog_manager'', ''platform:approval:read''),
      (''support_admin'', ''platform:tenant:read''),
      (''support_admin'', ''platform:catalog:read''),
      (''support_admin'', ''platform:subscription:read''),
      (''support_admin'', ''platform:subscription:support''),
      (''support_admin'', ''platform:billing:read''),
      (''support_admin'', ''platform:approval:read''),
      (''read_only_auditor'', ''platform:tenant:read''),
      (''read_only_auditor'', ''platform:catalog:read''),
      (''read_only_auditor'', ''platform:subscription:read''),
      (''read_only_auditor'', ''platform:billing:read''),
      (''read_only_auditor'', ''platform:approval:read''),
      (''read_only_auditor'', ''platform:commercial:audit:read'')
    ) AS t ("role_key", "scope_key")

  ; IF EXISTS (SELECT 1 FROM "_ccp_a1_role" t JOIN "identity"."Role" r ON r."id" = t."id" WHERE r."key" IS DISTINCT FROM t."key")
     OR EXISTS (SELECT 1 FROM "_ccp_a1_role" t JOIN "identity"."Role" r ON r."key" = t."key" WHERE r."id" IS DISTINCT FROM t."id")
     OR EXISTS (SELECT 1 FROM "_ccp_a1_scope" t JOIN "identity"."Scope" s ON s."id" = t."id" WHERE s."key" IS DISTINCT FROM t."key")
     OR EXISTS (SELECT 1 FROM "_ccp_a1_scope" t JOIN "identity"."Scope" s ON s."key" = t."key" WHERE s."id" IS DISTINCT FROM t."id") THEN
    RAISE EXCEPTION ''ccp_a1: role or scope id/key conflict refused (fixed ids only, no fallback)''
  ; END IF
  ; SELECT "id" INTO c_tr FROM "identity"."Scope" WHERE "key" = ''platform:tenant:read''
  ; IF c_tr IS NULL THEN
    RAISE EXCEPTION ''ccp_a1: platform:tenant:read scope absent, refused''
  ; END IF

  ; DROP TABLE IF EXISTS pg_temp."_ccp_a1_eff_before"
  ; CREATE TEMP TABLE "_ccp_a1_eff_before" ON COMMIT DROP AS
    SELECT DISTINCT m."tenant_id", m."user_id", rs."scope_id"
    FROM "identity"."UserTenantMembership" m
    JOIN "identity"."UserTenantMembershipRole" r ON r."membership_id" = m."id"
    JOIN "identity"."Role" ro ON ro."id" = r."role_id" AND ro."is_active"
    JOIN "identity"."RoleScope" rs ON rs."role_id" = r."role_id"

  ; INSERT INTO "identity"."Role" ("id", "key", "description", "is_active", "updated_at")
    SELECT t."id", t."key", t."description", true, now() FROM "_ccp_a1_role" t
    ON CONFLICT ("id") DO NOTHING
  ; GET DIAGNOSTICS v_roles = ROW_COUNT
  ; INSERT INTO "identity"."Scope" ("id", "key", "description")
    SELECT t."id", t."key", t."description" FROM "_ccp_a1_scope" t
    ON CONFLICT ("id") DO NOTHING
  ; GET DIAGNOSTICS v_scopes = ROW_COUNT
  ; INSERT INTO "identity"."RoleScope" ("id", "role_id", "scope_id")
    SELECT md5(''ccp-a1:'' || r."id"::text || '':'' || s."id"::text)::uuid, r."id", s."id"
    FROM "_ccp_a1_grant" g
    JOIN "_ccp_a1_role" r ON r."key" = g."role_key"
    JOIN "identity"."Scope" s ON s."key" = g."scope_key"
    ON CONFLICT ("role_id", "scope_id") DO NOTHING
  ; GET DIAGNOSTICS v_grants = ROW_COUNT

  ; IF EXISTS (SELECT 1 FROM "_ccp_a1_role" t LEFT JOIN "identity"."Role" r ON r."id" = t."id"
       WHERE r."id" IS NULL OR r."key" IS DISTINCT FROM t."key" OR r."description" IS DISTINCT FROM t."description" OR NOT r."is_active")
     OR EXISTS (SELECT 1 FROM "_ccp_a1_scope" t LEFT JOIN "identity"."Scope" s ON s."id" = t."id"
       WHERE s."id" IS NULL OR s."key" IS DISTINCT FROM t."key" OR s."description" IS DISTINCT FROM t."description") THEN
    RAISE EXCEPTION ''ccp_a1: role or scope row differs from the seed definition, refused''
  ; END IF
  ; IF EXISTS (
       (SELECT r."key", s."key" FROM "identity"."RoleScope" rs
          JOIN "identity"."Role" r ON r."id" = rs."role_id"
          JOIN "identity"."Scope" s ON s."id" = rs."scope_id"
          WHERE r."id" IN (SELECT "id" FROM "_ccp_a1_role")
            AND (s."key" IN (SELECT "key" FROM "_ccp_a1_scope") OR s."id" = c_tr)
        EXCEPT SELECT g."role_key", g."scope_key" FROM "_ccp_a1_grant" g)
       UNION ALL
       (SELECT g."role_key", g."scope_key" FROM "_ccp_a1_grant" g
        EXCEPT SELECT r."key", s."key" FROM "identity"."RoleScope" rs
          JOIN "identity"."Role" r ON r."id" = rs."role_id"
          JOIN "identity"."Scope" s ON s."id" = rs."scope_id")) THEN
    RAISE EXCEPTION ''ccp_a1: a CCP role bundle differs from the approved matrix, refused''
  ; END IF

  ; DROP TABLE IF EXISTS pg_temp."_ccp_a1_eff_after"
  ; CREATE TEMP TABLE "_ccp_a1_eff_after" ON COMMIT DROP AS
    SELECT DISTINCT m."tenant_id", m."user_id", rs."scope_id"
    FROM "identity"."UserTenantMembership" m
    JOIN "identity"."UserTenantMembershipRole" r ON r."membership_id" = m."id"
    JOIN "identity"."Role" ro ON ro."id" = r."role_id" AND ro."is_active"
    JOIN "identity"."RoleScope" rs ON rs."role_id" = r."role_id"
  ; SELECT count(*) INTO v_n FROM (
      SELECT d."tenant_id", d."user_id" FROM (
        (SELECT * FROM "_ccp_a1_eff_before" EXCEPT SELECT * FROM "_ccp_a1_eff_after")
        UNION
        (SELECT * FROM "_ccp_a1_eff_after" EXCEPT SELECT * FROM "_ccp_a1_eff_before")) d
      GROUP BY d."tenant_id", d."user_id") c
  ; IF v_n <> 0 THEN
    RAISE EXCEPTION ''ccp_a1: % principal(s) would change effective scopes, refused (the bump set must be empty)'', v_n
  ; END IF

  ; RAISE NOTICE ''ccp_a1: roles inserted: %, scopes inserted: %, grants inserted: %'', v_roles, v_scopes, v_grants
  ; RAISE NOTICE ''ccp_a1: authorization versions bumped: 0''
; END
';
