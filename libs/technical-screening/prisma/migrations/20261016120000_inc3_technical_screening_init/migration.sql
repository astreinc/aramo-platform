-- TIP-E2E INC-3 — Manual Technical Screening producer (additive).
-- ARAMO-TIP-E2E-INC-3-v1.0-LOCKED section 4: schema technical_screening, four
-- tables, UPDATE immutability enforced here, NO delete trigger and NO session
-- marker (deletion is confined in code to the talent-erasure inventory and DRAFT
-- finding removal, directive section 10.1). Cross-schema references are UUID-only
-- without FK constraints.

CREATE SCHEMA IF NOT EXISTS "technical_screening";

CREATE TABLE "technical_screening"."ScreeningSession" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID,
    "talent_record_id" UUID NOT NULL,
    "interaction_id" UUID,
    "state" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_by_actor_id" UUID,
    "confirmed_at" TIMESTAMPTZ(3),
    "confirmed_version" INTEGER,
    "confirmation_attested" BOOLEAN,
    "voided_by_actor_id" UUID,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" TEXT,
    CONSTRAINT "ScreeningSession_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScreeningSession_state_check" CHECK ("state" IN ('DRAFT', 'CONFIRMED', 'VOIDED')),
    CONSTRAINT "ScreeningSession_version_check" CHECK ("version" >= 1),
    CONSTRAINT "ScreeningSession_confirmed_fields_check" CHECK (
      "state" <> 'CONFIRMED' OR (
        "confirmed_by_actor_id" IS NOT NULL AND "confirmed_at" IS NOT NULL
        AND "confirmed_version" IS NOT NULL AND "confirmation_attested" IS TRUE
      )
    ),
    CONSTRAINT "ScreeningSession_voided_fields_check" CHECK (
      "state" <> 'VOIDED' OR ("voided_by_actor_id" IS NOT NULL AND "voided_at" IS NOT NULL)
    )
);

CREATE INDEX "ScreeningSession_tenant_id_talent_record_id_idx"
  ON "technical_screening"."ScreeningSession"("tenant_id", "talent_record_id");

CREATE TABLE "technical_screening"."ScreeningFinding" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "skill_raw" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "observation_raw" TEXT NOT NULL,
    "demonstration_raw" TEXT,
    "limitations_raw" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScreeningFinding_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScreeningFinding_basis_check" CHECK ("basis" IN ('SELF_REPORTED', 'RECRUITER_OBSERVED', 'DEMONSTRATED')),
    CONSTRAINT "ScreeningFinding_demonstration_check" CHECK (
      ("basis" = 'DEMONSTRATED' AND "demonstration_raw" IS NOT NULL AND length(btrim("demonstration_raw")) > 0)
      OR ("basis" <> 'DEMONSTRATED' AND "demonstration_raw" IS NULL)
    ),
    CONSTRAINT "ScreeningFinding_text_check" CHECK (
      length(btrim("skill_raw")) > 0 AND length(btrim("observation_raw")) > 0
    )
);

CREATE INDEX "ScreeningFinding_session_id_idx"
  ON "technical_screening"."ScreeningFinding"("session_id");

CREATE TABLE "technical_screening"."ScreeningEvidencePublication" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "finding_id" UUID NOT NULL,
    "evidence_record_id" UUID NOT NULL,
    "talent_record_id_at_confirm" UUID NOT NULL,
    "canonical_payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "collected_at" TIMESTAMPTZ(3) NOT NULL,
    "state" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScreeningEvidencePublication_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScreeningEvidencePublication_state_check" CHECK ("state" IN ('PENDING', 'PUBLISHED', 'CONFLICT')),
    CONSTRAINT "ScreeningEvidencePublication_attempt_check" CHECK ("attempt_count" >= 0)
);

CREATE UNIQUE INDEX "ScreeningEvidencePublication_finding_id_key"
  ON "technical_screening"."ScreeningEvidencePublication"("finding_id");
CREATE INDEX "ScreeningEvidencePublication_session_id_idx"
  ON "technical_screening"."ScreeningEvidencePublication"("session_id");

CREATE TABLE "technical_screening"."ScreeningEvent" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "session_version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScreeningEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ScreeningEvent_type_check" CHECK ("event_type" IN (
      'SESSION_CREATED', 'FINDING_ADDED', 'FINDING_EDITED', 'FINDING_REMOVED',
      'SESSION_CONFIRMED', 'SESSION_VOIDED', 'FINDING_PUBLISHED',
      'PUBLICATION_ATTEMPT_FAILED', 'PUBLICATION_CONFLICT'
    ))
);

CREATE INDEX "ScreeningEvent_session_id_idx"
  ON "technical_screening"."ScreeningEvent"("session_id");

-- ScreeningEvent: the audit ledger rejects every UPDATE.
CREATE OR REPLACE FUNCTION "technical_screening".reject_screening_event_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ScreeningEvent rows are append-only (TIP-E2E INC-3 section 4); UPDATE not permitted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_screening_event_update
  BEFORE UPDATE ON "technical_screening"."ScreeningEvent"
  FOR EACH ROW EXECUTE FUNCTION "technical_screening".reject_screening_event_update();

-- ScreeningFinding: editable only while its session is DRAFT.
CREATE OR REPLACE FUNCTION "technical_screening".reject_screening_finding_update()
RETURNS TRIGGER AS $$
DECLARE
  parent_state TEXT;
BEGIN
  SELECT s."state" INTO parent_state
    FROM "technical_screening"."ScreeningSession" s
   WHERE s."id" = OLD."session_id";
  IF parent_state IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'ScreeningFinding is immutable once its session leaves DRAFT (TIP-E2E INC-3 section 4); UPDATE not permitted'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_screening_finding_update
  BEFORE UPDATE ON "technical_screening"."ScreeningFinding"
  FOR EACH ROW EXECUTE FUNCTION "technical_screening".reject_screening_finding_update();

-- ScreeningSession: a CONFIRMED or VOIDED session is terminal. The only column a
-- non-DRAFT session may still change is the merge re-key target
-- (talent_record_id, with its updated_at), directive section 10.3.
CREATE OR REPLACE FUNCTION "technical_screening".reject_screening_session_terminal_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' AND (
       NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."site_id" IS DISTINCT FROM OLD."site_id"
    OR NEW."interaction_id" IS DISTINCT FROM OLD."interaction_id"
    OR NEW."state" IS DISTINCT FROM OLD."state"
    OR NEW."version" IS DISTINCT FROM OLD."version"
    OR NEW."created_by_actor_id" IS DISTINCT FROM OLD."created_by_actor_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."confirmed_by_actor_id" IS DISTINCT FROM OLD."confirmed_by_actor_id"
    OR NEW."confirmed_at" IS DISTINCT FROM OLD."confirmed_at"
    OR NEW."confirmed_version" IS DISTINCT FROM OLD."confirmed_version"
    OR NEW."confirmation_attested" IS DISTINCT FROM OLD."confirmation_attested"
    OR NEW."voided_by_actor_id" IS DISTINCT FROM OLD."voided_by_actor_id"
    OR NEW."voided_at" IS DISTINCT FROM OLD."voided_at"
    OR NEW."void_reason" IS DISTINCT FROM OLD."void_reason"
  ) THEN
    RAISE EXCEPTION 'ScreeningSession is immutable once CONFIRMED or VOIDED (TIP-E2E INC-3 section 5); only the merge re-key may change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_screening_session_terminal_update
  BEFORE UPDATE ON "technical_screening"."ScreeningSession"
  FOR EACH ROW EXECUTE FUNCTION "technical_screening".reject_screening_session_terminal_update();
