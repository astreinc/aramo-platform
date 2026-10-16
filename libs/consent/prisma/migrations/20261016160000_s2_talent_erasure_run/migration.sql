-- S2 Talent Erasure Integrity (Architect ruling F1 + F5; TM-L12 erasure
-- orchestration + object-storage deletion + auditable completion).
-- The durable, truthful state of one erasure run. The database pass commits
-- atomically; object-storage purge cannot join that transaction, so a run whose
-- objects are not yet verifiably purged stays STORAGE_PENDING (retryable) and the
-- consent.erased completion marker is appended ONLY when the run reaches
-- COMPLETED. Storage keys can embed an uploaded filename (PII), so an artifact's
-- key is held only while its purge is pending: on PURGED the key is cleared and
-- only its SHA-256 survives as the audit reference. No DELETE trigger is added
-- and no DELETE privilege is granted (no new deletion path).

CREATE TABLE "consent"."TalentErasureRun" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "record_id" UUID NOT NULL,
    "record_ids" UUID[] NOT NULL,
    "subject_ids" UUID[] NOT NULL,
    "state" TEXT NOT NULL,
    "artifact_count" INTEGER NOT NULL,
    "db_committed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "last_attempt_at" TIMESTAMPTZ(3),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "TalentErasureRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TalentErasureRun_state_check" CHECK ("state" IN ('STORAGE_PENDING', 'COMPLETED')),
    CONSTRAINT "TalentErasureRun_completed_check" CHECK (("state" = 'COMPLETED') = ("completed_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "TalentErasureRun_tenant_record_key" ON "consent"."TalentErasureRun"("tenant_id", "record_id");
CREATE INDEX "TalentErasureRun_state_idx" ON "consent"."TalentErasureRun"("state");

CREATE TABLE "consent"."TalentErasureArtifact" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "storage_key" TEXT,
    "storage_key_sha256" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "last_attempt_at" TIMESTAMPTZ(3),
    "purged_at" TIMESTAMPTZ(3),
    CONSTRAINT "TalentErasureArtifact_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TalentErasureArtifact_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "consent"."TalentErasureRun"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "TalentErasureArtifact_state_check" CHECK ("state" IN ('PENDING', 'FAILED', 'PURGED')),
    -- A purged artifact holds NO key (the key can carry PII); a pending one must.
    CONSTRAINT "TalentErasureArtifact_key_check" CHECK (("state" = 'PURGED') = ("storage_key" IS NULL)),
    CONSTRAINT "TalentErasureArtifact_purged_check" CHECK (("state" = 'PURGED') = ("purged_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "TalentErasureArtifact_run_key_hash_key" ON "consent"."TalentErasureArtifact"("run_id", "storage_key_sha256");

-- Truthful terminal states: a COMPLETED run and a PURGED artifact never revert,
-- and identity columns never change.
CREATE OR REPLACE FUNCTION "consent".reject_talent_erasure_run_regression()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."record_id" IS DISTINCT FROM OLD."record_id" OR NEW."record_ids" IS DISTINCT FROM OLD."record_ids"
     OR NEW."subject_ids" IS DISTINCT FROM OLD."subject_ids" OR NEW."artifact_count" IS DISTINCT FROM OLD."artifact_count"
     OR NEW."db_committed_at" IS DISTINCT FROM OLD."db_committed_at"
     OR (OLD."state" = 'COMPLETED') THEN
    RAISE EXCEPTION 'TalentErasureRun identity is immutable and a COMPLETED run never changes (S2)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_reject_talent_erasure_run_regression
  BEFORE UPDATE ON "consent"."TalentErasureRun"
  FOR EACH ROW EXECUTE FUNCTION "consent".reject_talent_erasure_run_regression();

CREATE OR REPLACE FUNCTION "consent".reject_talent_erasure_artifact_regression()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."run_id" IS DISTINCT FROM OLD."run_id" OR NEW."storage_key_sha256" IS DISTINCT FROM OLD."storage_key_sha256"
     OR (OLD."state" = 'PURGED') THEN
    RAISE EXCEPTION 'TalentErasureArtifact identity is immutable and a PURGED artifact never changes (S2)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_reject_talent_erasure_artifact_regression
  BEFORE UPDATE ON "consent"."TalentErasureArtifact"
  FOR EACH ROW EXECUTE FUNCTION "consent".reject_talent_erasure_artifact_regression();
