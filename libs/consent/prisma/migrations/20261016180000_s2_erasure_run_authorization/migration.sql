-- ARAMO-S2-Talent-Erasure-Integrity-Amendment-v1.0-LOCKED §2 (+ ratification
-- safeguards 1 and 2): the subject-bound, transaction-bound erasure
-- authorization. A trigger on an append-only table admits an erasure operation
-- ONLY when ALL of these hold — a session setting alone confers nothing:
--   1. the transaction-local setting app.talent_erasure_run names a
--      consent."TalentErasureRun" row that THIS transaction inserted
--      (xmin = the current top-level xid; never inside a SAVEPOINT);
--   2. that run is in the authorizing state DB_PASS_IN_PROGRESS (it must leave
--      it before COMMIT — a deferred constraint trigger rejects the commit);
--   3. the run's tenant is the row's tenant;
--   4. the row's owning talent is in the run's record_ids;
-- and the per-table trigger then enforces the permitted operation and the exact
-- redaction patch (§2.5 / §2.6), each in its owning lib's migration.
--
-- Safeguard 1 — run creation authority. A run can be created ONLY through the
-- SECURITY DEFINER entry point consent.s2_begin_talent_erasure_run, which runs as
-- the NOLOGIN role aramo_erasure_definer and computes the authorized record set
-- ITSELF (the husk chain of a TalentRecord that exists in the tenant) — a caller
-- cannot widen it. A BEFORE INSERT trigger rejects every INSERT not made by that
-- role, so ordinary application callers cannot manufacture a run (in any state).
-- EXECUTE on the entry point is revoked from PUBLIC and granted only to the
-- NOLOGIN role aramo_erasure_operator (an operator login is made a member of it;
-- a superuser bypasses grants by definition). Nobody is granted membership in
-- aramo_erasure_definer.
--
-- No trigger is disabled, session_replication_role is never touched, and no
-- historical migration is edited.

-- ---- the two NOLOGIN roles (cluster-global; idempotent and race-safe) ----
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aramo_erasure_definer') THEN
    CREATE ROLE aramo_erasure_definer NOLOGIN;
  END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aramo_erasure_operator') THEN
    CREATE ROLE aramo_erasure_operator NOLOGIN;
  END IF;
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END $$;

-- ---- the authorizing state ----
ALTER TABLE "consent"."TalentErasureRun" DROP CONSTRAINT "TalentErasureRun_state_check";
ALTER TABLE "consent"."TalentErasureRun" ADD CONSTRAINT "TalentErasureRun_state_check"
  CHECK ("state" IN ('DB_PASS_IN_PROGRESS', 'STORAGE_PENDING', 'COMPLETED'));

-- ---- safeguard 1: no INSERT except by the definer entry point ----
CREATE OR REPLACE FUNCTION "consent".reject_talent_erasure_run_forgery()
RETURNS TRIGGER AS $$
BEGIN
  IF current_user <> 'aramo_erasure_definer'
     OR NEW."state" <> 'DB_PASS_IN_PROGRESS' OR NEW."artifact_count" <> 0 OR NEW."completed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'TalentErasureRun rows are created only by consent.s2_begin_talent_erasure_run, in DB_PASS_IN_PROGRESS (S2 §2)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_reject_talent_erasure_run_forgery
  BEFORE INSERT ON "consent"."TalentErasureRun"
  FOR EACH ROW EXECUTE FUNCTION "consent".reject_talent_erasure_run_forgery();

-- ---- the lifecycle: DB_PASS_IN_PROGRESS → STORAGE_PENDING | COMPLETED;
--      STORAGE_PENDING → COMPLETED; never back into DB_PASS_IN_PROGRESS; identity
--      immutable; artifact_count fixed once the database pass ends; COMPLETED frozen ----
CREATE OR REPLACE FUNCTION "consent".reject_talent_erasure_run_regression()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."record_id" IS DISTINCT FROM OLD."record_id" OR NEW."record_ids" IS DISTINCT FROM OLD."record_ids"
     OR NEW."subject_ids" IS DISTINCT FROM OLD."subject_ids"
     OR NEW."db_committed_at" IS DISTINCT FROM OLD."db_committed_at"
     OR (OLD."state" = 'COMPLETED')
     OR (NEW."state" = 'DB_PASS_IN_PROGRESS' AND OLD."state" <> 'DB_PASS_IN_PROGRESS')
     OR (OLD."state" = 'STORAGE_PENDING' AND NEW."state" NOT IN ('STORAGE_PENDING', 'COMPLETED'))
     OR (OLD."state" <> 'DB_PASS_IN_PROGRESS' AND NEW."artifact_count" IS DISTINCT FROM OLD."artifact_count") THEN
    RAISE EXCEPTION 'TalentErasureRun identity is immutable and a COMPLETED run never changes (S2)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---- §2.2: a run may never COMMIT in DB_PASS_IN_PROGRESS ----
CREATE OR REPLACE FUNCTION "consent".reject_talent_erasure_run_left_in_progress()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "consent"."TalentErasureRun" r WHERE r."id" = NEW."id" AND r."state" = 'DB_PASS_IN_PROGRESS') THEN
    RAISE EXCEPTION 'TalentErasureRun cannot commit in DB_PASS_IN_PROGRESS (S2 §2.2)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_reject_talent_erasure_run_left_in_progress
  AFTER INSERT OR UPDATE ON "consent"."TalentErasureRun"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "consent".reject_talent_erasure_run_left_in_progress();

-- ---- §2.1–2.4: the authorized record set of the current transaction, or NULL ----
CREATE OR REPLACE FUNCTION "consent".s2_authorized_record_ids(p_tenant UUID)
RETURNS UUID[] AS $$
  SELECT r."record_ids"
    FROM "consent"."TalentErasureRun" r
   WHERE r."id"::text = current_setting('app.talent_erasure_run', true)
     AND r."state" = 'DB_PASS_IN_PROGRESS'
     AND r."tenant_id" = p_tenant
     AND r.xmin::text = (txid_current() % 4294967296)::text
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION "consent".s2_run_authorizes(p_tenant UUID, p_record UUID)
RETURNS BOOLEAN AS $$
  SELECT COALESCE(p_record = ANY ("consent".s2_authorized_record_ids(p_tenant)), false)
$$ LANGUAGE sql STABLE;

-- ---- safeguard 1: the ONE entry point that creates an authorizing run ----
CREATE OR REPLACE FUNCTION "consent".s2_begin_talent_erasure_run(
  p_run UUID, p_tenant UUID, p_record UUID, p_subject_ids UUID[]
) RETURNS UUID[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_record_ids UUID[];
BEGIN
  IF COALESCE(current_setting('app.talent_erasure_run', true), '') <> '' THEN
    RAISE EXCEPTION 'an erasure run is already authorized in this transaction (S2 §2)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM talent_record."TalentRecord" t WHERE t.tenant_id = p_tenant AND t.id = p_record) THEN
    RAISE EXCEPTION 'erasure run refused: no TalentRecord with this id in this tenant (S2 §2)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The authorized set is computed HERE (the whole husk chain), never taken from the caller.
  WITH RECURSIVE chain(id, sby) AS (
    SELECT t.id, t.superseded_by_record_id FROM talent_record."TalentRecord" t
     WHERE t.tenant_id = p_tenant AND t.id = p_record
    UNION
    SELECT t.id, t.superseded_by_record_id FROM talent_record."TalentRecord" t
      JOIN chain c ON (t.superseded_by_record_id = c.id OR t.id = c.sby)
     WHERE t.tenant_id = p_tenant
  )
  SELECT array_agg(DISTINCT id ORDER BY id) INTO v_record_ids FROM chain;
  INSERT INTO "consent"."TalentErasureRun" ("id", "tenant_id", "record_id", "record_ids", "subject_ids", "state", "artifact_count")
  VALUES (p_run, p_tenant, p_record, v_record_ids, COALESCE(p_subject_ids, '{}'::uuid[]), 'DB_PASS_IN_PROGRESS', 0);
  PERFORM set_config('app.talent_erasure_run', p_run::text, true);
  RETURN v_record_ids;
END;
$$;

GRANT USAGE ON SCHEMA "consent" TO aramo_erasure_definer;
GRANT SELECT, INSERT ON "consent"."TalentErasureRun" TO aramo_erasure_definer;
DO $$
BEGIN
  IF to_regclass('talent_record."TalentRecord"') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA talent_record TO aramo_erasure_definer;
    GRANT SELECT ON talent_record."TalentRecord" TO aramo_erasure_definer;
  END IF;
END $$;
ALTER FUNCTION "consent".s2_begin_talent_erasure_run(UUID, UUID, UUID, UUID[]) OWNER TO aramo_erasure_definer;
REVOKE ALL ON FUNCTION "consent".s2_begin_talent_erasure_run(UUID, UUID, UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "consent".s2_begin_talent_erasure_run(UUID, UUID, UUID, UUID[]) TO aramo_erasure_operator;
