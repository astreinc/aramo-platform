-- ARAMO-S2-Talent-Erasure-Integrity-Amendment-v1.0-LOCKED §0 / §2 (Gate-5 C — no
-- false completion under CONCURRENT transactions). Under READ COMMITTED a holder
-- row written by a concurrent, not-yet-committed transaction is invisible to the
-- erasure's preflight, so a sequential re-check cannot close the race. This
-- migration makes writers and the erasure SERIALIZE on the talent's identity:
--   * every write of a talent-keyed column takes a SHARED transaction advisory lock
--     on that talent (and, for a re-pointing UPDATE, on the old talent too);
--   * the erasure pass takes the EXCLUSIVE lock on every record of the husk chain —
--     and on each of the talent's contact values (read before the pass deletes
--     them) — BEFORE its in-transaction preflight;
--   * a writer that waited behind a committed erasure is then refused: no row may
--     name a record id the run ledger records as erased (no resurrection).
-- So a writer that started first makes the erasure wait and then BLOCK (or erase
-- the row), and a writer that arrives during the pass waits and is refused.
-- Contact-keyed holders (sourced_talent."SourcedTalent") serialize the same way on
-- the normalized contact value. Lock keys follow the repo convention
-- (hashtextextended(namespace || id, 0)). Triggers are attached only to tables
-- that exist; the holder-coverage proof asserts every talent-keyed table has one.

CREATE INDEX IF NOT EXISTS "TalentErasureRun_record_ids_gin" ON "consent"."TalentErasureRun" USING gin ("record_ids");

CREATE OR REPLACE FUNCTION "consent".s2_talent_lock_key(p_record UUID) RETURNS BIGINT
LANGUAGE sql IMMUTABLE AS $$ SELECT hashtextextended('aramo.s2.erasure.talent:' || p_record::text, 0) $$;

CREATE OR REPLACE FUNCTION "consent".s2_contact_lock_key(p_value TEXT) RETURNS BIGINT
LANGUAGE sql IMMUTABLE AS $$ SELECT hashtextextended('aramo.s2.erasure.contact:' || lower(btrim(p_value)), 0) $$;

-- The erasure side: exclusive locks, in a stable order, on the record ids and then on
-- the talent's contact values (stable pre-deletion identity: read under the talent
-- locks, so no contact method of this talent can be added or removed meanwhile).
CREATE OR REPLACE FUNCTION "consent".s2_lock_talent_identity(p_record_ids UUID[]) RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_n INTEGER := 0;
  v_key BIGINT;
BEGIN
  FOR v_key IN SELECT DISTINCT "consent".s2_talent_lock_key(r) FROM unnest(p_record_ids) r ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(v_key);
    v_n := v_n + 1;
  END LOOP;
  FOR v_key IN
    SELECT DISTINCT "consent".s2_contact_lock_key(cm.value) FROM talent_evidence."TalentContactMethod" cm
     WHERE cm.talent_id = ANY (p_record_ids) AND cm.value IS NOT NULL ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(v_key);
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;

-- The writer side, talent-keyed. TG_ARGV[0] = the talent column; optional
-- TG_ARGV[1] / TG_ARGV[2] = discriminator column / value of a polymorphic table.
CREATE OR REPLACE FUNCTION "consent".s2_guard_talent_write() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_new UUID;
  v_old UUID;
BEGIN
  IF TG_NARGS >= 3 AND (to_jsonb(NEW) ->> TG_ARGV[1]) IS DISTINCT FROM TG_ARGV[2] THEN
    RETURN NEW;
  END IF;
  v_new := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  IF TG_OP = 'UPDATE' THEN
    v_old := (to_jsonb(OLD) ->> TG_ARGV[0])::uuid;
    IF v_old IS NOT NULL AND v_old IS DISTINCT FROM v_new THEN
      PERFORM pg_advisory_xact_lock_shared("consent".s2_talent_lock_key(v_old));
    END IF;
  END IF;
  IF v_new IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock_shared("consent".s2_talent_lock_key(v_new));
  IF EXISTS (SELECT 1 FROM "consent"."TalentErasureRun" r WHERE r."record_ids" @> ARRAY[v_new]) THEN
    RAISE EXCEPTION 'talent % has been erased: % may not name it (S2)', v_new, TG_TABLE_NAME
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- The writer side, contact-keyed. TG_ARGV = the contact columns.
CREATE OR REPLACE FUNCTION "consent".s2_guard_contact_write() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_col TEXT;
  v_value TEXT;
BEGIN
  FOREACH v_col IN ARRAY TG_ARGV LOOP
    v_value := to_jsonb(NEW) ->> v_col;
    IF v_value IS NOT NULL AND length(btrim(v_value)) > 0 THEN
      PERFORM pg_advisory_xact_lock_shared("consent".s2_contact_lock_key(v_value));
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('client_selection', 'ClientSelectionProcess', 'talent_id', NULL, NULL),
    ('client_selection', 'InterviewSession', 'talent_record_id', NULL, NULL),
    ('client_talent_restriction', 'ClientTalentRestriction', 'talent_record_id', NULL, NULL),
    ('communications', 'MeetingSchedulingOperation', 'talent_record_id', NULL, NULL),
    ('consent', 'TalentConsentEvent', 'talent_record_id', NULL, NULL),
    ('evidence', 'TalentJobEvidencePackage', 'talent_id', NULL, NULL),
    ('examination', 'CanonicalMatchShadowObservation', 'talent_id', NULL, NULL),
    ('examination', 'TalentJobExamination', 'talent_id', NULL, NULL),
    ('offer', 'Offer', 'talent_record_id', NULL, NULL),
    ('pipeline', 'Pipeline', 'talent_record_id', NULL, NULL),
    ('pipeline', 'TalentRequisitionResume', 'talent_record_id', NULL, NULL),
    ('placement', 'AssignmentRateVersion', 'talent_record_id', NULL, NULL),
    ('placement', 'CommercialRevisionProposal', 'talent_record_id', NULL, NULL),
    ('placement', 'ContractAssignment', 'talent_record_id', NULL, NULL),
    ('placement', 'PermanentPlacement', 'talent_record_id', NULL, NULL),
    ('placement', 'PermanentPlacementRemedy', 'talent_record_id', NULL, NULL),
    ('placement', 'PlacementProcess', 'talent_record_id', NULL, NULL),
    ('selection', 'TalentSelection', 'talent_id', NULL, NULL),
    ('submittal', 'TalentSubmittalRecord', 'talent_id', NULL, NULL),
    ('submittal_policy', 'SubmittalConsumption', 'talent_record_id', NULL, NULL),
    ('talent_embedding', 'TalentEmbedding', 'talent_record_id', NULL, NULL),
    ('talent_evidence', 'ResumeExtractionDraft', 'talent_id', NULL, NULL),
    ('talent_evidence', 'TalentCertificationEntry', 'talent_id', NULL, NULL),
    ('talent_evidence', 'TalentContactMethod', 'talent_id', NULL, NULL),
    ('talent_evidence', 'TalentDerivedSnapshot', 'talent_id', NULL, NULL),
    ('talent_evidence', 'TalentDocument', 'talent_id', NULL, NULL),
    ('talent_evidence', 'TalentEducationEntry', 'talent_id', NULL, NULL),
    ('talent_evidence', 'TalentIntakeDraft', 'promoted_talent_record_id', NULL, NULL),
    ('talent_evidence', 'TalentProjectExperience', 'talent_id', NULL, NULL),
    ('talent_evidence', 'TalentRateExpectation', 'talent_id', NULL, NULL),
    ('talent_evidence', 'TalentResumeDefault', 'talent_id', NULL, NULL),
    ('talent_evidence', 'TalentResumeEdition', 'talent_id', NULL, NULL),
    ('talent_evidence', 'TalentSkillEvidence', 'talent_id', NULL, NULL),
    ('talent_evidence', 'TalentWorkAuthorization', 'talent_id', NULL, NULL),
    ('talent_evidence', 'TalentWorkHistoryEntry', 'talent_id', NULL, NULL),
    ('talent_trust', 'VerificationRequest', 'talent_record_id', NULL, NULL),
    ('technical_screening', 'ScreeningSession', 'talent_record_id', NULL, NULL),
    ('activity', 'Activity', 'subject_id', 'subject_type', 'talent_record'),
    ('attachment', 'Attachment', 'owner_id', 'owner_type', 'talent'),
    ('task', 'Task', 'owner_id', 'owner_type', 'talent_record'),
    ('saved_list', 'SavedListEntry', 'item_id', 'item_type', 'talent_record'),
    ('communications', 'CommunicationAssociation', 'subject_id', 'subject_type', 'talent_record'),
    ('documents', 'DocumentAssociation', 'resource_id', 'resource_type', 'TALENT'),
    ('documents', 'DocumentRequirement', 'resource_id', 'resource_type', 'TALENT')
  ) AS v(s, n, col, dcol, dval) LOOP
    IF to_regclass(format('%I.%I', t.s, t.n)) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_s2_guard_talent_write ON %I.%I', t.s, t.n);
      IF t.dcol IS NULL THEN
        EXECUTE format(
          'CREATE TRIGGER trg_s2_guard_talent_write BEFORE INSERT OR UPDATE OF %I ON %I.%I FOR EACH ROW EXECUTE FUNCTION "consent".s2_guard_talent_write(%L)',
          t.col, t.s, t.n, t.col);
      ELSE
        EXECUTE format(
          'CREATE TRIGGER trg_s2_guard_talent_write BEFORE INSERT OR UPDATE OF %I, %I ON %I.%I FOR EACH ROW EXECUTE FUNCTION "consent".s2_guard_talent_write(%L, %L, %L)',
          t.col, t.dcol, t.s, t.n, t.col, t.dcol, t.dval);
      END IF;
    END IF;
  END LOOP;
  IF to_regclass('sourced_talent."SourcedTalent"') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_s2_guard_contact_write ON sourced_talent."SourcedTalent";
    CREATE TRIGGER trg_s2_guard_contact_write BEFORE INSERT OR UPDATE OF normalized_email, normalized_phone
      ON sourced_talent."SourcedTalent" FOR EACH ROW
      EXECUTE FUNCTION "consent".s2_guard_contact_write('normalized_email', 'normalized_phone');
  END IF;
END $$;
