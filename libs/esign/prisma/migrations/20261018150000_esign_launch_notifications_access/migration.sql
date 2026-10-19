-- Aramo Sign standalone launch (Aramo-Sign-Standalone-Product-Final-Implementation-
-- Authorization-v1_0) — lifecycle notifications + the signer's signed-copy access.
-- Additive only.

-- 1. A voided envelope now notifies its recipients; record that delivery kind.
ALTER TABLE "esign"."NotificationDelivery" DROP CONSTRAINT "NotificationDelivery_kind_check";
ALTER TABLE "esign"."NotificationDelivery"
  ADD CONSTRAINT "NotificationDelivery_kind_check"
  CHECK ("notification_kind" IN ('SIGNATURE_REQUEST', 'SIGNATURE_REMINDER', 'SIGNATURE_COMPLETED', 'SIGNATURE_DECLINED', 'SIGNATURE_EXPIRED', 'SIGNATURE_VOIDED'));

-- 2. A time-limited capability that lets a signer download the executed document
-- and certificate of a COMPLETED envelope (the completion email carries the link).
-- Like SigningSession, only sha256(base64url) of the raw token is stored.
CREATE TABLE "esign"."ExecutedAccessGrant" (
  "id"               UUID        NOT NULL,
  "tenant_id"        UUID        NOT NULL,
  "envelope_id"      UUID        NOT NULL,
  "signer_id"        UUID        NOT NULL,
  "token_hash"       TEXT        NOT NULL,
  "expires_at"       TIMESTAMPTZ NOT NULL,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "last_accessed_at" TIMESTAMPTZ,
  "access_count"     INTEGER     NOT NULL DEFAULT 0,
  CONSTRAINT "ExecutedAccessGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExecutedAccessGrant_envelope_fkey" FOREIGN KEY ("envelope_id") REFERENCES "esign"."SignatureEnvelope"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "ExecutedAccessGrant_token_hash_key" ON "esign"."ExecutedAccessGrant"("token_hash");
CREATE INDEX "ExecutedAccessGrant_tenant_id_idx" ON "esign"."ExecutedAccessGrant"("tenant_id");
CREATE INDEX "ExecutedAccessGrant_envelope_id_idx" ON "esign"."ExecutedAccessGrant"("envelope_id");
