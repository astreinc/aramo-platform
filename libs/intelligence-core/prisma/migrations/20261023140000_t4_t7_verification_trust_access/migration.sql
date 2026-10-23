-- ATI-SEP-1 T4-T7 (ADR-0036 Sections 3, 5, 6) — verification requests, the
-- materialized trust state, tenant entitlement, the read audit and per-reference
-- webhook deliveries. Applied ONLY by tools/db-sync-intelligence.sh.
-- splitDdl-safe: no semicolons in comments.
-- CreateTable
CREATE TABLE "intelligence"."VerificationRequest" (
    "id" UUID NOT NULL,
    "subject_id" UUID,
    "identifier_type" TEXT NOT NULL,
    "normalized_value" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "code_salt" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "outcome" TEXT,
    "requested_by_reference_id" UUID,
    "requested_by_client_id" TEXT NOT NULL,
    "portal_session_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ(6),

    CONSTRAINT "VerificationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence"."SubjectTrustState" (
    "subject_id" UUID NOT NULL,
    "identity_band" TEXT NOT NULL,
    "claims_band" TEXT NOT NULL,
    "continuity_band" TEXT NOT NULL,
    "eligibility_band" TEXT NOT NULL,
    "open_contradiction_count" INTEGER NOT NULL,
    "stale_assertion_count" INTEGER NOT NULL,
    "has_open_dispute" BOOLEAN NOT NULL,
    "single_source_only" BOOLEAN NOT NULL,
    "verification_stale" BOOLEAN NOT NULL,
    "assessed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SubjectTrustState_pkey" PRIMARY KEY ("subject_id")
);

-- CreateTable
CREATE TABLE "intelligence"."EntitledTenant" (
    "source_system_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntitledTenant_pkey" PRIMARY KEY ("source_system_id","tenant_id")
);

-- CreateTable
CREATE TABLE "intelligence"."IntelligenceReadAudit" (
    "id" UUID NOT NULL,
    "client_id" TEXT NOT NULL,
    "source_system_id" TEXT NOT NULL,
    "source_tenant_id" TEXT NOT NULL,
    "external_talent_id" TEXT NOT NULL,
    "read_kind" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "access_mode" TEXT,
    "reference_id" UUID,
    "subject_id" UUID,
    "fields_returned" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntelligenceReadAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intelligence"."IntelligenceWebhookDelivery" (
    "id" UUID NOT NULL,
    "outbox_event_id" UUID NOT NULL,
    "reference_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "source_system_id" TEXT NOT NULL,
    "source_tenant_id" TEXT NOT NULL,
    "external_talent_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(6),
    "lease_expires_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "delivered_at" TIMESTAMPTZ(6),
    "quarantined_at" TIMESTAMPTZ(6),

    CONSTRAINT "IntelligenceWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VerificationRequest_identifier_type_normalized_value_status_idx" ON "intelligence"."VerificationRequest"("identifier_type", "normalized_value", "status");

-- CreateIndex
CREATE INDEX "VerificationRequest_subject_id_idx" ON "intelligence"."VerificationRequest"("subject_id");

-- CreateIndex
CREATE INDEX "SubjectTrustState_assessed_at_idx" ON "intelligence"."SubjectTrustState"("assessed_at");

-- CreateIndex
CREATE INDEX "IntelligenceReadAudit_source_tenant_id_created_at_idx" ON "intelligence"."IntelligenceReadAudit"("source_tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "IntelligenceReadAudit_subject_id_idx" ON "intelligence"."IntelligenceReadAudit"("subject_id");

-- CreateIndex
CREATE INDEX "IntelligenceWebhookDelivery_reference_id_idx" ON "intelligence"."IntelligenceWebhookDelivery"("reference_id");

-- CreateIndex
CREATE UNIQUE INDEX "IntelligenceWebhookDelivery_outbox_event_id_reference_id_key" ON "intelligence"."IntelligenceWebhookDelivery"("outbox_event_id", "reference_id");

-- AddForeignKey
ALTER TABLE "intelligence"."VerificationRequest" ADD CONSTRAINT "VerificationRequest_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "intelligence"."GoldenTalent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."VerificationRequest" ADD CONSTRAINT "VerificationRequest_requested_by_reference_id_fkey" FOREIGN KEY ("requested_by_reference_id") REFERENCES "intelligence"."ExternalTalentReference"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."SubjectTrustState" ADD CONSTRAINT "SubjectTrustState_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "intelligence"."GoldenTalent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."IntelligenceWebhookDelivery" ADD CONSTRAINT "IntelligenceWebhookDelivery_outbox_event_id_fkey" FOREIGN KEY ("outbox_event_id") REFERENCES "intelligence"."IntelligenceOutbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intelligence"."IntelligenceWebhookDelivery" ADD CONSTRAINT "IntelligenceWebhookDelivery_reference_id_fkey" FOREIGN KEY ("reference_id") REFERENCES "intelligence"."ExternalTalentReference"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- Closed vocabularies as CHECK constraints.
-- ============================================================================
ALTER TABLE "intelligence"."VerificationRequest"
  ADD CONSTRAINT "VerificationRequest_identifier_type_check" CHECK ("identifier_type" IN ('EMAIL', 'PHONE')),
  ADD CONSTRAINT "VerificationRequest_channel_check" CHECK ("channel" IN ('EMAIL', 'SMS')),
  ADD CONSTRAINT "VerificationRequest_status_check" CHECK ("status" IN ('PENDING', 'CONFIRMED', 'EXPIRED', 'LOCKED')),
  ADD CONSTRAINT "VerificationRequest_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('BOUND', 'ALREADY_BOUND', 'ANCHOR_CONTRADICTION', 'UNBOUND')),
  ADD CONSTRAINT "VerificationRequest_attempts_check" CHECK ("attempts" >= 0 AND "attempts" <= "max_attempts"),
  -- The code is never stored: only a salted sha256 (64 lowercase hex).
  ADD CONSTRAINT "VerificationRequest_code_hash_check" CHECK ("code_hash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "VerificationRequest_confirmed_check" CHECK (("status" = 'CONFIRMED') = ("confirmed_at" IS NOT NULL));

ALTER TABLE "intelligence"."SubjectTrustState"
  ADD CONSTRAINT "SubjectTrustState_identity_band_check" CHECK ("identity_band" IN ('NOT_ESTABLISHED', 'SELF_ASSERTED', 'CORROBORATED', 'INDEPENDENTLY_VERIFIED', 'AUTHORITATIVE')),
  ADD CONSTRAINT "SubjectTrustState_claims_band_check" CHECK ("claims_band" IN ('NOT_ESTABLISHED', 'SELF_ASSERTED', 'CORROBORATED', 'INDEPENDENTLY_VERIFIED', 'AUTHORITATIVE')),
  ADD CONSTRAINT "SubjectTrustState_continuity_band_check" CHECK ("continuity_band" IN ('NOT_ESTABLISHED', 'SELF_ASSERTED', 'CORROBORATED', 'INDEPENDENTLY_VERIFIED', 'AUTHORITATIVE')),
  ADD CONSTRAINT "SubjectTrustState_eligibility_band_check" CHECK ("eligibility_band" IN ('NOT_ESTABLISHED', 'SELF_ASSERTED', 'CORROBORATED', 'INDEPENDENTLY_VERIFIED', 'AUTHORITATIVE'));

ALTER TABLE "intelligence"."IntelligenceReadAudit"
  ADD CONSTRAINT "IntelligenceReadAudit_read_kind_check" CHECK ("read_kind" IN ('PROFILE', 'EVIDENCE', 'ARTIFACTS')),
  ADD CONSTRAINT "IntelligenceReadAudit_outcome_check" CHECK ("outcome" IN ('GRANTED', 'NOT_ENTITLED', 'SOURCE_SYSTEM_MISMATCH', 'REFERENCE_NOT_FOUND')),
  ADD CONSTRAINT "IntelligenceReadAudit_access_mode_check" CHECK ("access_mode" IS NULL OR "access_mode" IN ('TENANT_SCOPED', 'CROSS_TENANT'));

-- At most one PENDING request per (subject, identifier): a newer request expires the older one.
CREATE INDEX "VerificationRequest_pending_idx"
  ON "intelligence"."VerificationRequest" ("identifier_type", "normalized_value")
  WHERE "status" = 'PENDING';

-- Delivery claim scan (undelivered, not quarantined).
CREATE INDEX "IntelligenceWebhookDelivery_pending_idx"
  ON "intelligence"."IntelligenceWebhookDelivery" ("created_at")
  WHERE "delivered_at" IS NULL AND "quarantined_at" IS NULL;

-- The read audit is append-only and retained (no UPDATE, no DELETE).
CREATE TRIGGER intelligence_read_audit_no_update
  BEFORE UPDATE ON "intelligence"."IntelligenceReadAudit"
  FOR EACH ROW EXECUTE FUNCTION "intelligence".reject_update_append_only();

CREATE TRIGGER intelligence_read_audit_no_delete
  BEFORE DELETE ON "intelligence"."IntelligenceReadAudit"
  FOR EACH ROW EXECUTE FUNCTION "intelligence".reject_evidence_delete();

INSERT INTO "intelligence"."ServiceInfo" ("key", "value")
VALUES ('verification_trust_access', 'ATI-SEP-1-T4-T7')
ON CONFLICT ("key") DO NOTHING;
