-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "client_talent_restriction";

-- CreateEnum
CREATE TYPE "client_talent_restriction"."RestrictionType" AS ENUM ('CLIENT_DO_NOT_RESUBMIT', 'CLIENT_NOT_ELIGIBLE_FOR_REENGAGEMENT', 'CLIENT_SITE_ACCESS_RESTRICTED', 'VMS_SUBMITTAL_RESTRICTED');

-- CreateEnum
CREATE TYPE "client_talent_restriction"."AssertedByType" AS ENUM ('CLIENT', 'MSP', 'VMS', 'CLIENT_LEGAL_COMPLIANCE');

-- CreateEnum
CREATE TYPE "client_talent_restriction"."SourceSystem" AS ENUM ('FIELDGLASS', 'BEELINE', 'WORKDAY_VNDLY', 'COUPA', 'ORACLE', 'CLIENT_EMAIL', 'CLIENT_PORTAL', 'MANUAL_TRANSCRIPTION');

-- CreateEnum
CREATE TYPE "client_talent_restriction"."CloseReasonCode" AS ENUM ('CLIENT_WITHDRAWN', 'CLIENT_RESCINDED', 'SUPERSEDED_BY_NEW_ASSERTION', 'RECORDED_IN_ERROR');

-- CreateTable
CREATE TABLE "client_talent_restriction"."ClientTalentRestriction" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_company_id" UUID NOT NULL,
    "talent_record_id" UUID NOT NULL,
    "restriction_type" "client_talent_restriction"."RestrictionType" NOT NULL,
    "asserted_by_type" "client_talent_restriction"."AssertedByType" NOT NULL,
    "asserting_organization_reference" TEXT,
    "asserting_contact_reference" TEXT,
    "source_system" "client_talent_restriction"."SourceSystem" NOT NULL,
    "source_reference" TEXT NOT NULL,
    "raw_source_value" TEXT,
    "reason_code" TEXT NOT NULL,
    "recorded_by" UUID NOT NULL,
    "effective_from" TIMESTAMPTZ NOT NULL,
    "scheduled_end_at" TIMESTAMPTZ,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMPTZ,
    "closed_at" TIMESTAMPTZ,
    "closed_by" UUID,
    "close_reason_code" "client_talent_restriction"."CloseReasonCode",
    "close_source_system" "client_talent_restriction"."SourceSystem",
    "close_source_reference" TEXT,

    CONSTRAINT "ClientTalentRestriction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Idempotency identity (E7 §3b correction 4). A same-source retry maps to
-- the one canonical row. Different-source duplicates of the same type are
-- PERMITTED because source_system and source_reference differ.
CREATE UNIQUE INDEX "ClientTalentRestriction_assertion_identity_key" ON "client_talent_restriction"."ClientTalentRestriction"("tenant_id", "source_system", "source_reference", "restriction_type");

-- CreateIndex
-- Reads are ALWAYS client-and-talent-scoped (E7 R2/R3). There is NO index
-- leading with talent_record_id alone, by design (no cross-client lookup).
CREATE INDEX "ClientTalentRestriction_tenant_id_client_company_id_talent__idx" ON "client_talent_restriction"."ClientTalentRestriction"("tenant_id", "client_company_id", "talent_record_id");

-- ============================================================================
-- ClientTalentRestriction column-scoped immutability — E7 §5 (RULED).
--
-- Append-and-close only. Exactly ONE permitted UPDATE branch: the
-- explicit close, which moves effective_to plus all FIVE closure
-- provenance columns together from NULL to non-NULL, atomically, in one
-- operation. Every other column must be byte-identical OLD versus NEW
-- (equality for NOT NULL columns, IS NOT DISTINCT FROM for nullable). The
-- fallthrough RAISE rejects reopening, partial closure, closure-field
-- edits, and any change to scheduled_end_at, effective_from, assertion
-- provenance, or the client/talent/type/idempotency identity.
--
-- scheduled_end_at is pinned here too, so a creation-time scheduled expiry
-- can NEVER be mutated after insert (Option B immutability).
--
-- NOTE: keep this comment block free of literal semicolons and free of the
-- dollar-quote delimiter sequence -- the integration migration splitter is
-- dollar-quote-aware but does not strip line comments, so either token
-- inside a comment confuses it (submittal init-migration precedent).
-- ============================================================================
CREATE OR REPLACE FUNCTION client_talent_restriction.reject_client_talent_restriction_update()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.effective_to IS NULL AND NEW.effective_to IS NOT NULL
      AND OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL
      AND OLD.closed_by IS NULL AND NEW.closed_by IS NOT NULL
      AND OLD.close_reason_code IS NULL AND NEW.close_reason_code IS NOT NULL
      AND OLD.close_source_system IS NULL AND NEW.close_source_system IS NOT NULL
      AND OLD.close_source_reference IS NULL AND NEW.close_source_reference IS NOT NULL
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.client_company_id = NEW.client_company_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.restriction_type = NEW.restriction_type
      AND OLD.asserted_by_type = NEW.asserted_by_type
      AND OLD.asserting_organization_reference IS NOT DISTINCT FROM NEW.asserting_organization_reference
      AND OLD.asserting_contact_reference IS NOT DISTINCT FROM NEW.asserting_contact_reference
      AND OLD.source_system = NEW.source_system
      AND OLD.source_reference = NEW.source_reference
      AND OLD.raw_source_value IS NOT DISTINCT FROM NEW.raw_source_value
      AND OLD.reason_code = NEW.reason_code
      AND OLD.recorded_by = NEW.recorded_by
      AND OLD.effective_from = NEW.effective_from
      AND OLD.scheduled_end_at IS NOT DISTINCT FROM NEW.scheduled_end_at
      AND OLD.recorded_at = NEW.recorded_at)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'ClientTalentRestriction is append-and-close-only per E7 R4/R4b -- the only permitted update is the atomic close writing effective_to with all five closure-provenance columns together -- reopening, partial closure, closure-field edits, and any change to scheduled_end_at, effective_from, assertion provenance, or the client/talent/type/idempotency identity are rejected'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_client_talent_restriction_update
  BEFORE UPDATE ON client_talent_restriction."ClientTalentRestriction"
  FOR EACH ROW EXECUTE FUNCTION client_talent_restriction.reject_client_talent_restriction_update();

-- ============================================================================
-- No delete path (E7 R4). Deleting erases the fact that the restriction was
-- asserted, which is the thing being recorded. Defense-in-depth alongside
-- the repository exposing no delete method -- a BEFORE DELETE trigger
-- rejects any row deletion at the database layer.
-- ============================================================================
CREATE OR REPLACE FUNCTION client_talent_restriction.reject_client_talent_restriction_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'ClientTalentRestriction is not deletable per E7 R4 -- reversal is by effective_to plus closure provenance, never by DELETE'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reject_client_talent_restriction_delete
  BEFORE DELETE ON client_talent_restriction."ClientTalentRestriction"
  FOR EACH ROW EXECUTE FUNCTION client_talent_restriction.reject_client_talent_restriction_delete();
