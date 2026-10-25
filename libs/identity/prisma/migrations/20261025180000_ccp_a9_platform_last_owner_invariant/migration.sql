-- CCP-A9 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A9; T2-F1-H3 Amendment A1
-- A1-4) — the last-effective-platform_owner invariant. Once the platform has an effective
-- platform_owner, no write may leave it with zero. An effective holder is an assignment row
-- (UserTenantMembershipRole) of the role whose key is platform_owner, on an ACTIVE membership
-- of the Aramo Platform sentinel tenant, held by an ACTIVE User.
--
-- Cloned from the ROLES-1 tenant_last_owner trigger set (20261021120100, A1-4 "the model is
-- ROLES-1 §4"). Checked ONLY when a write removes a holder that counted (the OLD row was an
-- effective owner), so the zero-to-zero state before the bootstrap is admitted and unrelated
-- writes never consult the count. Covered writes (AFTER ROW, so the count sees the change):
--   UserTenantMembershipRole  DELETE, UPDATE OF role_id / membership_id   (role removal)
--   UserTenantMembership      DELETE, UPDATE OF is_active / tenant_id / user_id
--   User                      UPDATE OF is_active                        (user deactivation)
-- There is no tenant-status condition (A1-4 states none).
--
-- Concurrency: every check first takes pg_advisory_xact_lock(hashtext('identity:platform_owner'))
-- and counts AFTER the lock, FOR SHARE on the owner rows (the ROLES-1 pattern), so two
-- concurrent removals serialize.
--
-- No bypass (ROLES-1 :90): the functions read no GUC, no session setting and no skip flag;
-- ENABLE ALWAYS keeps them firing under session_replication_role. The only break-glass is the
-- documented superuser ALTER TABLE DISABLE TRIGGER runbook, PO-authorized (ROLES-1 :92).
--
-- The sentinel tenant id is the platform constant (libs/auth PLATFORM_TENANT_SENTINEL_ID).
-- ADDITIVE: new functions and triggers only; no row, column or existing trigger changes.
-- REPLAY-SAFE: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS before CREATE TRIGGER.
-- Splitter-safe (the ROLES-1 / IC-1 PR-3 convention): every function body is a SINGLE-QUOTED
-- one-line string (no dollar quoting, no statement terminator at a line end inside a body, no
-- double hyphen inside a body).

-- The check (shared by every trigger)
CREATE OR REPLACE FUNCTION "identity".ccp_a9_assert_platform_keeps_owner() RETURNS void LANGUAGE plpgsql AS 'DECLARE v_owners INTEGER; BEGIN PERFORM pg_advisory_xact_lock(hashtext(''identity:platform_owner'')); SELECT count(*) INTO v_owners FROM (SELECT 1 FROM "identity"."UserTenantMembershipRole" r JOIN "identity"."UserTenantMembership" m ON m."id" = r."membership_id" JOIN "identity"."User" u ON u."id" = m."user_id" JOIN "identity"."Role" ro ON ro."id" = r."role_id" WHERE m."tenant_id" = ''01900000-0000-7000-8000-000000000100''::uuid AND m."is_active" AND u."is_active" AND ro."key" = ''platform_owner'' FOR SHARE OF r, m, u) s; IF v_owners = 0 THEN RAISE EXCEPTION ''platform_last_owner: the platform must keep at least one active platform_owner'' USING ERRCODE = ''integrity_constraint_violation''; END IF; END';

-- UserTenantMembershipRole: the removed (or re-pointed) assignment counted when it was the
-- platform_owner role on an active sentinel membership of an active user.
CREATE OR REPLACE FUNCTION "identity".ccp_a9_guard_platform_owner_role() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF EXISTS (SELECT 1 FROM "identity"."UserTenantMembership" m JOIN "identity"."User" u ON u."id" = m."user_id" JOIN "identity"."Role" ro ON ro."id" = OLD."role_id" WHERE m."id" = OLD."membership_id" AND m."tenant_id" = ''01900000-0000-7000-8000-000000000100''::uuid AND m."is_active" AND u."is_active" AND ro."key" = ''platform_owner'') THEN PERFORM "identity".ccp_a9_assert_platform_keeps_owner(); END IF; RETURN NULL; END';

-- UserTenantMembership: the deactivated / deleted / re-pointed membership counted when it was
-- an active sentinel membership of an active user holding platform_owner.
CREATE OR REPLACE FUNCTION "identity".ccp_a9_guard_platform_owner_membership() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF OLD."is_active" AND OLD."tenant_id" = ''01900000-0000-7000-8000-000000000100''::uuid AND EXISTS (SELECT 1 FROM "identity"."User" u WHERE u."id" = OLD."user_id" AND u."is_active") AND EXISTS (SELECT 1 FROM "identity"."UserTenantMembershipRole" r JOIN "identity"."Role" ro ON ro."id" = r."role_id" WHERE r."membership_id" = OLD."id" AND ro."key" = ''platform_owner'') THEN PERFORM "identity".ccp_a9_assert_platform_keeps_owner(); END IF; RETURN NULL; END';

-- User: a deactivated user counted when an active sentinel membership of theirs holds
-- platform_owner.
CREATE OR REPLACE FUNCTION "identity".ccp_a9_guard_platform_owner_user() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF EXISTS (SELECT 1 FROM "identity"."UserTenantMembership" m JOIN "identity"."UserTenantMembershipRole" r ON r."membership_id" = m."id" JOIN "identity"."Role" ro ON ro."id" = r."role_id" WHERE m."user_id" = OLD."id" AND m."tenant_id" = ''01900000-0000-7000-8000-000000000100''::uuid AND m."is_active" AND ro."key" = ''platform_owner'') THEN PERFORM "identity".ccp_a9_assert_platform_keeps_owner(); END IF; RETURN NULL; END';

-- Triggers (replay-safe pairs)
DROP TRIGGER IF EXISTS "ccp_a9_platform_last_owner_role_delete" ON "identity"."UserTenantMembershipRole";
CREATE TRIGGER "ccp_a9_platform_last_owner_role_delete" AFTER DELETE ON "identity"."UserTenantMembershipRole" FOR EACH ROW EXECUTE FUNCTION "identity".ccp_a9_guard_platform_owner_role();
DROP TRIGGER IF EXISTS "ccp_a9_platform_last_owner_role_update" ON "identity"."UserTenantMembershipRole";
CREATE TRIGGER "ccp_a9_platform_last_owner_role_update" AFTER UPDATE OF "role_id", "membership_id" ON "identity"."UserTenantMembershipRole" FOR EACH ROW WHEN (OLD."role_id" IS DISTINCT FROM NEW."role_id" OR OLD."membership_id" IS DISTINCT FROM NEW."membership_id") EXECUTE FUNCTION "identity".ccp_a9_guard_platform_owner_role();
DROP TRIGGER IF EXISTS "ccp_a9_platform_last_owner_membership_delete" ON "identity"."UserTenantMembership";
CREATE TRIGGER "ccp_a9_platform_last_owner_membership_delete" AFTER DELETE ON "identity"."UserTenantMembership" FOR EACH ROW EXECUTE FUNCTION "identity".ccp_a9_guard_platform_owner_membership();
DROP TRIGGER IF EXISTS "ccp_a9_platform_last_owner_membership_update" ON "identity"."UserTenantMembership";
CREATE TRIGGER "ccp_a9_platform_last_owner_membership_update" AFTER UPDATE OF "is_active", "tenant_id", "user_id" ON "identity"."UserTenantMembership" FOR EACH ROW WHEN (OLD."is_active" AND (NOT NEW."is_active" OR OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id" OR OLD."user_id" IS DISTINCT FROM NEW."user_id")) EXECUTE FUNCTION "identity".ccp_a9_guard_platform_owner_membership();
DROP TRIGGER IF EXISTS "ccp_a9_platform_last_owner_user_update" ON "identity"."User";
CREATE TRIGGER "ccp_a9_platform_last_owner_user_update" AFTER UPDATE OF "is_active" ON "identity"."User" FOR EACH ROW WHEN (OLD."is_active" AND NOT NEW."is_active") EXECUTE FUNCTION "identity".ccp_a9_guard_platform_owner_user();

-- No session-level skip: ENABLE ALWAYS fires each trigger under every session_replication_role.
ALTER TABLE "identity"."UserTenantMembershipRole" ENABLE ALWAYS TRIGGER "ccp_a9_platform_last_owner_role_delete";
ALTER TABLE "identity"."UserTenantMembershipRole" ENABLE ALWAYS TRIGGER "ccp_a9_platform_last_owner_role_update";
ALTER TABLE "identity"."UserTenantMembership" ENABLE ALWAYS TRIGGER "ccp_a9_platform_last_owner_membership_delete";
ALTER TABLE "identity"."UserTenantMembership" ENABLE ALWAYS TRIGGER "ccp_a9_platform_last_owner_membership_update";
ALTER TABLE "identity"."User" ENABLE ALWAYS TRIGGER "ccp_a9_platform_last_owner_user_update";
