-- Aramo-Sign-Domain-Isolation-Reconciliation-V1-Directive-v1_0-LOCKED §2 R-2/R-4, §4 D-4 —
-- per-domain PostgreSQL group roles for the shared `aramo` database.
--
-- REVIEWED ROLLOUT ONLY. Running this in production is a separately authorized step (exact
-- SQL, credentials, dependency analysis and rollback reviewed by the Lead and PO); see
-- documents/Aramo-Sign-Domain-Isolation-DB-Role-Rollout-Plan. Nothing in the deploy or
-- migration tooling runs it.
--
-- Run as the migration owner (today the `aramo` superuser that owns every schema), in the
-- `aramo` database, AFTER every migration run (it is idempotent: re-running converges the
-- grants for schemas and tables a later migration created). Plain SQL, no psql variables:
-- it creates NOLOGIN group roles and their grants only. Login roles (with passwords) are
-- created by the operator per the rollout plan and granted ONE group role each.
--
--   aramo_ats_rw       apps/api, talent-intake-worker and the CLIs run from the api image:
--                      every application schema EXCEPT sign (and intelligence, ADR-0036).
--                      No USAGE on sign: the ATS cannot read, insert, update or delete a
--                      Sign table, directly or through a trigger it fires.
--   aramo_sign_rw      sign-service: sign plus the platform schemas Sign uses (identity,
--                      auth_storage, entitlement, subscription, metering).
--   aramo_auth_rw      auth-service: every application schema except sign and intelligence.
--   aramo_platform_rw  platform-admin, the operator console: every application schema except
--                      intelligence (it decides Sign abuse reports and reads the Sign privacy
--                      inventory by design; narrowing it is a recorded follow-up).
--
-- The migration owner keeps ownership of every object; no group role owns or can ALTER/DROP
-- anything. Table privileges are SELECT, INSERT, UPDATE, DELETE (no TRUNCATE, REFERENCES or
-- TRIGGER); sequences USAGE, SELECT, UPDATE. EXECUTE stays as each migration set it (PUBLIC by
-- default; the S2 erasure entry point is granted to its operator role only).

DO $roles$
DECLARE
  r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['aramo_ats_rw', 'aramo_sign_rw', 'aramo_auth_rw', 'aramo_platform_rw'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r);
    END IF;
  END LOOP;
END
$roles$;

DO $grants$
DECLARE
  -- Application schemas: everything a migration created, never the catalogs.
  app_schemas TEXT[];
  s TEXT;
  plan JSONB := jsonb_build_object(
    'aramo_ats_rw',      jsonb_build_object('mode', 'all_except', 'schemas', jsonb_build_array('sign', 'intelligence')),
    'aramo_sign_rw',     jsonb_build_object('mode', 'only',       'schemas', jsonb_build_array('sign', 'identity', 'auth_storage', 'entitlement', 'subscription', 'metering')),
    'aramo_auth_rw',     jsonb_build_object('mode', 'all_except', 'schemas', jsonb_build_array('sign', 'intelligence')),
    'aramo_platform_rw', jsonb_build_object('mode', 'all_except', 'schemas', jsonb_build_array('intelligence'))
  );
  role TEXT;
  listed TEXT[];
  allowed BOOLEAN;
BEGIN
  SELECT array_agg(nspname ORDER BY nspname) INTO app_schemas
    FROM pg_namespace
   WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     AND nspname NOT LIKE 'pg_temp_%' AND nspname NOT LIKE 'pg_toast_temp_%';

  FOR role IN SELECT jsonb_object_keys(plan) LOOP
    SELECT array_agg(v) INTO listed FROM jsonb_array_elements_text(plan -> role -> 'schemas') v;
    FOREACH s IN ARRAY app_schemas LOOP
      IF plan -> role ->> 'mode' = 'only' THEN
        allowed := s = ANY (listed);
      ELSE
        allowed := NOT (s = ANY (listed));
      END IF;
      IF allowed THEN
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', s, role);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', s, role);
        EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO %I', s, role);
        -- Tables and sequences a later migration (run by this same owner) creates.
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', current_user, s, role);
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', current_user, s, role);
      ELSE
        -- Converge: a schema this role must not reach carries no privilege at all for it.
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON TABLES FROM %I', current_user, s, role);
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM %I', current_user, s, role);
        EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', s, role);
        EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', s, role);
        EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', s, role);
      END IF;
    END LOOP;
  END LOOP;
END
$grants$;

-- The Sign schema is reachable by no one but its grantees: no PUBLIC privilege on it.
DO $public$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'sign') THEN
    REVOKE ALL ON SCHEMA sign FROM PUBLIC;
    REVOKE ALL ON ALL TABLES IN SCHEMA sign FROM PUBLIC;
  END IF;
END
$public$;

-- Postcondition (fail loudly, never a silent partial grant): the ATS role reaches no Sign
-- table, and the Sign role reaches every one of them.
DO $verify$
DECLARE
  v_hit TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'sign') THEN
    IF has_schema_privilege('aramo_ats_rw', 'sign', 'USAGE') THEN
      RAISE EXCEPTION 'domain roles: aramo_ats_rw still has USAGE on schema sign';
    END IF;
    SELECT format('%I.%I', schemaname, tablename) INTO v_hit FROM pg_tables
     WHERE schemaname = 'sign'
       AND (has_table_privilege('aramo_ats_rw', format('%I.%I', schemaname, tablename), 'SELECT,INSERT,UPDATE,DELETE')
            OR NOT has_table_privilege('aramo_sign_rw', format('%I.%I', schemaname, tablename), 'SELECT')
            OR NOT has_table_privilege('aramo_sign_rw', format('%I.%I', schemaname, tablename), 'INSERT')
            OR NOT has_table_privilege('aramo_sign_rw', format('%I.%I', schemaname, tablename), 'UPDATE')
            OR NOT has_table_privilege('aramo_sign_rw', format('%I.%I', schemaname, tablename), 'DELETE'))
     LIMIT 1;
    IF v_hit IS NOT NULL THEN
      RAISE EXCEPTION 'domain roles: wrong privileges on %', v_hit;
    END IF;
  END IF;
END
$verify$;
