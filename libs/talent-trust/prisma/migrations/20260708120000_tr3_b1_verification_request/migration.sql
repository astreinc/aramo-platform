-- TR-3 B1 (DDR §2.2) — the email-verification request table. The invitation
-- token pattern verbatim: a secret is emailed as the confirm link and only its
-- sha256 hash lives here (token_hash), single-use via consumed_at under an atomic
-- replay-guarded transaction, app-side 72h TTL.
--
-- Both keys are carried: consent + recruiter context key by record
-- (talent_record_id), the anchor mints on the subject (subject_id). anchor_kind
-- is EMAIL only in v1. All ids are bare UUIDs, no cross-schema FK (I1).
--
-- Landed WRITER-LESS in B1 (the supersession precedent) — the request/confirm
-- flow is T3-B2. Additive-only, no existing table touched.

-- CreateTable
CREATE TABLE "talent_trust"."VerificationRequest" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "talent_record_id" UUID NOT NULL,
    "subject_id" UUID NOT NULL,
    "anchor_kind" TEXT NOT NULL,
    "normalized_value" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,

    CONSTRAINT "VerificationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VerificationRequest_token_hash_key" ON "talent_trust"."VerificationRequest"("token_hash");

-- CreateIndex
CREATE INDEX "VerificationRequest_tenant_id_status_idx" ON "talent_trust"."VerificationRequest"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "VerificationRequest_subject_id_idx" ON "talent_trust"."VerificationRequest"("subject_id");
