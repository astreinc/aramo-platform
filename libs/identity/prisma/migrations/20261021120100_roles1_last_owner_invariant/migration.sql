-- Aramo-ROLES-1 Implementation Directive v1.0 (LOCKED) §4.1 — last-owner invariant (ADR-0035
-- safeguard 2). A tenant whose status is ACTIVE or PROVISIONED must keep at least one ACTIVE
-- tenant_owner: an assignment row (UserTenantMembershipRole) of the role whose key is
-- tenant_owner, on an active membership of that tenant, held by an active User.
--
-- Checked ONLY when a write removes an owner that counted (the OLD row was an active owner),
-- so an already-ownerless tenant (e.g. the PROVISIONED platform sentinel) is never blocked by
-- unrelated writes. Covered writes (AFTER ROW, so the count sees the row change):
--   UserTenantMembershipRole  DELETE, UPDATE OF role_id / membership_id
--   UserTenantMembership      DELETE, UPDATE OF is_active / tenant_id / user_id
--   User                      UPDATE OF is_active (every tenant in which the user is an owner)
--
-- Concurrency: every check first takes pg_advisory_xact_lock(hashtext('identity:owner:' || tenant))
-- and counts AFTER the lock (precedent: the S2 guard, consent 20261016190000), so two concurrent
-- removals serialize. Under READ COMMITTED the second waits, then its fresh statement snapshot
-- sees the first one's committed removal. The count locks the owner rows FOR SHARE, so under
-- REPEATABLE READ / SERIALIZABLE a concurrently removed owner aborts with a serialization
-- failure instead of being counted from a stale snapshot.
--
-- Safeguard S-1: there is NO bypass. The functions read no GUC, no session setting and no skip
-- flag. The only break-glass is a superuser ALTER TABLE DISABLE TRIGGER, documented in
-- doc/runbooks/tenant-last-owner-invariant.md.
--
-- REPLAY-SAFE: CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS before CREATE TRIGGER.
-- Splitter-safe (IC-1 PR-3 precedent): every function body is a SINGLE-QUOTED one-line string
-- (no dollar quoting, no inline statement terminator at a line end, no double hyphen inside a
-- body), so the line-based test-harness splitters and the quote-aware scanner keep each
-- statement intact.

-- The check (shared by every trigger)
CREATE OR REPLACE FUNCTION "identity".roles1_assert_tenant_keeps_owner(p_tenant UUID) RETURNS void LANGUAGE plpgsql AS 'DECLARE v_status TEXT; v_owners INTEGER; BEGIN IF p_tenant IS NULL THEN RETURN; END IF; PERFORM pg_advisory_xact_lock(hashtext(''identity:owner:'' || p_tenant::text)); SELECT t."status" INTO v_status FROM "identity"."Tenant" t WHERE t."id" = p_tenant; IF v_status IS NULL OR v_status NOT IN (''ACTIVE'', ''PROVISIONED'') THEN RETURN; END IF; SELECT count(*) INTO v_owners FROM (SELECT 1 FROM "identity"."UserTenantMembershipRole" r JOIN "identity"."UserTenantMembership" m ON m."id" = r."membership_id" JOIN "identity"."User" u ON u."id" = m."user_id" JOIN "identity"."Role" ro ON ro."id" = r."role_id" WHERE m."tenant_id" = p_tenant AND m."is_active" AND u."is_active" AND ro."key" = ''tenant_owner'' FOR SHARE OF r, m, u) s; IF v_owners = 0 THEN RAISE EXCEPTION ''tenant_last_owner: tenant % must keep at least one active tenant_owner'', p_tenant USING ERRCODE = ''integrity_constraint_violation''; END IF; END';

-- UserTenantMembershipRole: the removed (or re-pointed) assignment counted when it was the
-- tenant_owner role on an active membership of an active user.
CREATE OR REPLACE FUNCTION "identity".roles1_guard_membership_role() RETURNS trigger LANGUAGE plpgsql AS 'DECLARE v_tenant UUID; BEGIN SELECT m."tenant_id" INTO v_tenant FROM "identity"."UserTenantMembership" m JOIN "identity"."User" u ON u."id" = m."user_id" JOIN "identity"."Role" ro ON ro."id" = OLD."role_id" WHERE m."id" = OLD."membership_id" AND m."is_active" AND u."is_active" AND ro."key" = ''tenant_owner''; IF v_tenant IS NOT NULL THEN PERFORM "identity".roles1_assert_tenant_keeps_owner(v_tenant); END IF; RETURN NULL; END';

-- UserTenantMembership: the deactivated / deleted / re-pointed membership counted when it was
-- active, its user active, and it held tenant_owner.
CREATE OR REPLACE FUNCTION "identity".roles1_guard_membership() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN IF OLD."is_active" AND EXISTS (SELECT 1 FROM "identity"."User" u WHERE u."id" = OLD."user_id" AND u."is_active") AND EXISTS (SELECT 1 FROM "identity"."UserTenantMembershipRole" r JOIN "identity"."Role" ro ON ro."id" = r."role_id" WHERE r."membership_id" = OLD."id" AND ro."key" = ''tenant_owner'') THEN PERFORM "identity".roles1_assert_tenant_keeps_owner(OLD."tenant_id"); END IF; RETURN NULL; END';

-- User: a deactivated user counted as an owner in every tenant where an active membership of
-- theirs holds tenant_owner (checked in a stable tenant order).
CREATE OR REPLACE FUNCTION "identity".roles1_guard_user() RETURNS trigger LANGUAGE plpgsql AS 'DECLARE v_tenant UUID; BEGIN FOR v_tenant IN SELECT DISTINCT m."tenant_id" FROM "identity"."UserTenantMembership" m JOIN "identity"."UserTenantMembershipRole" r ON r."membership_id" = m."id" JOIN "identity"."Role" ro ON ro."id" = r."role_id" WHERE m."user_id" = OLD."id" AND m."is_active" AND ro."key" = ''tenant_owner'' ORDER BY 1 LOOP PERFORM "identity".roles1_assert_tenant_keeps_owner(v_tenant); END LOOP; RETURN NULL; END';

-- Triggers (replay-safe pairs)
DROP TRIGGER IF EXISTS "roles1_last_owner_role_delete" ON "identity"."UserTenantMembershipRole";
CREATE TRIGGER "roles1_last_owner_role_delete" AFTER DELETE ON "identity"."UserTenantMembershipRole" FOR EACH ROW EXECUTE FUNCTION "identity".roles1_guard_membership_role();
DROP TRIGGER IF EXISTS "roles1_last_owner_role_update" ON "identity"."UserTenantMembershipRole";
CREATE TRIGGER "roles1_last_owner_role_update" AFTER UPDATE OF "role_id", "membership_id" ON "identity"."UserTenantMembershipRole" FOR EACH ROW WHEN (OLD."role_id" IS DISTINCT FROM NEW."role_id" OR OLD."membership_id" IS DISTINCT FROM NEW."membership_id") EXECUTE FUNCTION "identity".roles1_guard_membership_role();
DROP TRIGGER IF EXISTS "roles1_last_owner_membership_delete" ON "identity"."UserTenantMembership";
CREATE TRIGGER "roles1_last_owner_membership_delete" AFTER DELETE ON "identity"."UserTenantMembership" FOR EACH ROW EXECUTE FUNCTION "identity".roles1_guard_membership();
DROP TRIGGER IF EXISTS "roles1_last_owner_membership_update" ON "identity"."UserTenantMembership";
CREATE TRIGGER "roles1_last_owner_membership_update" AFTER UPDATE OF "is_active", "tenant_id", "user_id" ON "identity"."UserTenantMembership" FOR EACH ROW WHEN (OLD."is_active" AND (NOT NEW."is_active" OR OLD."tenant_id" IS DISTINCT FROM NEW."tenant_id" OR OLD."user_id" IS DISTINCT FROM NEW."user_id")) EXECUTE FUNCTION "identity".roles1_guard_membership();
DROP TRIGGER IF EXISTS "roles1_last_owner_user_update" ON "identity"."User";
CREATE TRIGGER "roles1_last_owner_user_update" AFTER UPDATE OF "is_active" ON "identity"."User" FOR EACH ROW WHEN (OLD."is_active" AND NOT NEW."is_active") EXECUTE FUNCTION "identity".roles1_guard_user();

-- Safeguard S-1 — no session-level skip. ENABLE ALWAYS makes each trigger fire under every
-- session_replication_role (a superuser session setting that otherwise silences ordinary
-- triggers, and the application runs as a superuser in production). Only an explicit
-- superuser ALTER TABLE DISABLE TRIGGER (the runbook break-glass) stops them.
ALTER TABLE "identity"."UserTenantMembershipRole" ENABLE ALWAYS TRIGGER "roles1_last_owner_role_delete";
ALTER TABLE "identity"."UserTenantMembershipRole" ENABLE ALWAYS TRIGGER "roles1_last_owner_role_update";
ALTER TABLE "identity"."UserTenantMembership" ENABLE ALWAYS TRIGGER "roles1_last_owner_membership_delete";
ALTER TABLE "identity"."UserTenantMembership" ENABLE ALWAYS TRIGGER "roles1_last_owner_membership_update";
ALTER TABLE "identity"."User" ENABLE ALWAYS TRIGGER "roles1_last_owner_user_update";
