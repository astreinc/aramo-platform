-- DOC-3 — Native E-Sign Service Core (greenfield esign schema). ATS-neutral.
-- Governing directive Aramo-DOC-3-Native-ESign-Service-Core-Slice-Directive-v1_0-LOCKED.
-- References Documents ONLY by opaque UUID (no cross-schema FK). SignatureEvent
-- is append-only with a tamper-evident hash chain (unconditional UPDATE/DELETE
-- reject trigger, RN-1/DocumentEvent precedent, no NULL-comparison gap).
-- splitDdl-safe: no semicolons inside comment lines, trigger body dollar-quoted.

CREATE SCHEMA IF NOT EXISTS "esign";

-- CreateTable SignatureEnvelope
CREATE TABLE "esign"."SignatureEnvelope" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "subject" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "execution_mode" TEXT NOT NULL,
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "sent_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "declined_at" TIMESTAMPTZ,
  "voided_at" TIMESTAMPTZ,
  "expires_at" TIMESTAMPTZ,
  CONSTRAINT "SignatureEnvelope_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignatureEnvelope_status_check" CHECK ("status" IN ('DRAFT', 'SENT', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED')),
  CONSTRAINT "SignatureEnvelope_execmode_check" CHECK ("execution_mode" IN ('ACKNOWLEDGEMENT', 'SINGLE_SIGNATURE', 'MULTI_SIGNATURE'))
);
CREATE INDEX "SignatureEnvelope_tenant_id_idx" ON "esign"."SignatureEnvelope" ("tenant_id");
CREATE INDEX "SignatureEnvelope_tenant_id_status_idx" ON "esign"."SignatureEnvelope" ("tenant_id", "status");

-- CreateTable EnvelopeDocument
CREATE TABLE "esign"."EnvelopeDocument" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "envelope_id" UUID NOT NULL,
  "document_ref" UUID NOT NULL,
  "document_revision_ref" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "source_sha256" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  CONSTRAINT "EnvelopeDocument_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EnvelopeDocument_envelope_document_key" ON "esign"."EnvelopeDocument" ("envelope_id", "document_ref");
CREATE INDEX "EnvelopeDocument_tenant_id_idx" ON "esign"."EnvelopeDocument" ("tenant_id");
CREATE INDEX "EnvelopeDocument_envelope_id_idx" ON "esign"."EnvelopeDocument" ("envelope_id");

-- CreateTable Signer
CREATE TABLE "esign"."Signer" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "envelope_id" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "signing_order" INTEGER NOT NULL,
  "signer_role" TEXT,
  "status" TEXT NOT NULL,
  "viewed_at" TIMESTAMPTZ,
  "signed_at" TIMESTAMPTZ,
  "declined_at" TIMESTAMPTZ,
  "decline_reason" TEXT,
  CONSTRAINT "Signer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Signer_status_check" CHECK ("status" IN ('PENDING', 'VIEWED', 'SIGNED', 'DECLINED'))
);
CREATE UNIQUE INDEX "Signer_envelope_order_key" ON "esign"."Signer" ("envelope_id", "signing_order");
CREATE INDEX "Signer_tenant_id_idx" ON "esign"."Signer" ("tenant_id");
CREATE INDEX "Signer_envelope_id_idx" ON "esign"."Signer" ("envelope_id");

-- CreateTable SignatureField
CREATE TABLE "esign"."SignatureField" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "envelope_document_id" UUID NOT NULL,
  "signer_id" UUID,
  "field_type" TEXT NOT NULL,
  "signature_method" TEXT,
  "page_number" INTEGER NOT NULL,
  "x" DOUBLE PRECISION NOT NULL,
  "y" DOUBLE PRECISION NOT NULL,
  "width" DOUBLE PRECISION,
  "height" DOUBLE PRECISION,
  "required" BOOLEAN NOT NULL DEFAULT true,
  "value" TEXT,
  "filled_at" TIMESTAMPTZ,
  CONSTRAINT "SignatureField_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignatureField_type_check" CHECK ("field_type" IN ('SIGNATURE', 'INITIALS', 'SIGN_DATE', 'SIGNER_NAME', 'TEXT', 'CHECKBOX', 'ACKNOWLEDGEMENT')),
  CONSTRAINT "SignatureField_method_check" CHECK ("signature_method" IS NULL OR "signature_method" IN ('TYPED', 'DRAWN', 'UPLOADED', 'DIGITAL_CERTIFICATE'))
);
CREATE INDEX "SignatureField_tenant_id_idx" ON "esign"."SignatureField" ("tenant_id");
CREATE INDEX "SignatureField_envelope_document_id_idx" ON "esign"."SignatureField" ("envelope_document_id");
CREATE INDEX "SignatureField_signer_id_idx" ON "esign"."SignatureField" ("signer_id");

-- CreateTable SigningSession
CREATE TABLE "esign"."SigningSession" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "envelope_id" UUID NOT NULL,
  "signer_id" UUID NOT NULL,
  "token_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "expires_at" TIMESTAMPTZ NOT NULL,
  "first_accessed_at" TIMESTAMPTZ,
  "last_accessed_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "revoked_at" TIMESTAMPTZ,
  "failed_auth_count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "SigningSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SigningSession_status_check" CHECK ("status" IN ('ISSUED', 'EXCHANGED', 'ACTIVE', 'COMPLETED', 'EXPIRED', 'REVOKED'))
);
CREATE UNIQUE INDEX "SigningSession_token_hash_key" ON "esign"."SigningSession" ("token_hash");
CREATE INDEX "SigningSession_tenant_id_idx" ON "esign"."SigningSession" ("tenant_id");
CREATE INDEX "SigningSession_envelope_id_idx" ON "esign"."SigningSession" ("envelope_id");
CREATE INDEX "SigningSession_signer_id_idx" ON "esign"."SigningSession" ("signer_id");

-- CreateTable SignerDisclosureAcceptance
CREATE TABLE "esign"."SignerDisclosureAcceptance" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "signer_id" UUID NOT NULL,
  "disclosure_version" TEXT NOT NULL,
  "disclosure_text_hash" TEXT NOT NULL,
  "accepted_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "ip_address" TEXT,
  "user_agent" TEXT,
  "session_id" UUID NOT NULL,
  CONSTRAINT "SignerDisclosureAcceptance_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SignerDisclosureAcceptance_tenant_id_idx" ON "esign"."SignerDisclosureAcceptance" ("tenant_id");
CREATE INDEX "SignerDisclosureAcceptance_signer_id_idx" ON "esign"."SignerDisclosureAcceptance" ("signer_id");

-- CreateTable SignatureEvent (append-only)
CREATE TABLE "esign"."SignatureEvent" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "envelope_id" UUID NOT NULL,
  "signer_id" UUID,
  "event_type" TEXT NOT NULL,
  "actor_type" TEXT NOT NULL,
  "actor_ref" UUID,
  "payload" JSONB,
  "previous_event_hash" TEXT,
  "event_hash" TEXT NOT NULL,
  "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "ip_address" TEXT,
  "user_agent" TEXT,
  CONSTRAINT "SignatureEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignatureEvent_actor_type_check" CHECK ("actor_type" IN ('SIGNER', 'SYSTEM', 'SERVICE'))
);
CREATE INDEX "SignatureEvent_tenant_envelope_occurred_idx" ON "esign"."SignatureEvent" ("tenant_id", "envelope_id", "occurred_at");
CREATE INDEX "SignatureEvent_tenant_occurred_idx" ON "esign"."SignatureEvent" ("tenant_id", "occurred_at");

-- CreateTable NotificationDelivery
CREATE TABLE "esign"."NotificationDelivery" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "envelope_id" UUID NOT NULL,
  "signer_id" UUID,
  "notification_kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "sent_at" TIMESTAMPTZ,
  CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationDelivery_kind_check" CHECK ("notification_kind" IN ('SIGNATURE_REQUEST', 'SIGNATURE_REMINDER', 'SIGNATURE_COMPLETED', 'SIGNATURE_DECLINED', 'SIGNATURE_EXPIRED')),
  CONSTRAINT "NotificationDelivery_status_check" CHECK ("status" IN ('PENDING', 'SENT', 'FAILED'))
);
CREATE INDEX "NotificationDelivery_tenant_id_idx" ON "esign"."NotificationDelivery" ("tenant_id");
CREATE INDEX "NotificationDelivery_envelope_id_idx" ON "esign"."NotificationDelivery" ("envelope_id");

-- CreateTable IdempotencyKey
CREATE TABLE "esign"."IdempotencyKey" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "response_status" INTEGER,
  "response_body" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IdempotencyKey_tenant_id_key_key" ON "esign"."IdempotencyKey" ("tenant_id", "key");

-- CreateTable OutboxEvent
CREATE TABLE "esign"."OutboxEvent" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "event_type" TEXT NOT NULL,
  "event_payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "published_at" TIMESTAMPTZ,
  CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OutboxEvent_published_at_idx" ON "esign"."OutboxEvent" ("published_at");

-- Intra-esign foreign keys (real, same-schema).
ALTER TABLE "esign"."EnvelopeDocument"
  ADD CONSTRAINT "EnvelopeDocument_envelope_id_fkey"
  FOREIGN KEY ("envelope_id") REFERENCES "esign"."SignatureEnvelope" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "esign"."Signer"
  ADD CONSTRAINT "Signer_envelope_id_fkey"
  FOREIGN KEY ("envelope_id") REFERENCES "esign"."SignatureEnvelope" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "esign"."SignatureField"
  ADD CONSTRAINT "SignatureField_envelope_document_id_fkey"
  FOREIGN KEY ("envelope_document_id") REFERENCES "esign"."EnvelopeDocument" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "esign"."SignatureField"
  ADD CONSTRAINT "SignatureField_signer_id_fkey"
  FOREIGN KEY ("signer_id") REFERENCES "esign"."Signer" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "esign"."SigningSession"
  ADD CONSTRAINT "SigningSession_envelope_id_fkey"
  FOREIGN KEY ("envelope_id") REFERENCES "esign"."SignatureEnvelope" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "esign"."SigningSession"
  ADD CONSTRAINT "SigningSession_signer_id_fkey"
  FOREIGN KEY ("signer_id") REFERENCES "esign"."Signer" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "esign"."SignerDisclosureAcceptance"
  ADD CONSTRAINT "SignerDisclosureAcceptance_signer_id_fkey"
  FOREIGN KEY ("signer_id") REFERENCES "esign"."Signer" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "esign"."SignatureEvent"
  ADD CONSTRAINT "SignatureEvent_envelope_id_fkey"
  FOREIGN KEY ("envelope_id") REFERENCES "esign"."SignatureEnvelope" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SignatureEvent append-only immutability (DB-enforced, unconditional — RN-1 /
-- DocumentEvent precedent, no OLD/NEW NULL-comparison gap).
CREATE OR REPLACE FUNCTION esign.reject_signature_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'SignatureEvent is append-only (DOC-3): UPDATE and DELETE are rejected';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER signature_event_append_only
  BEFORE UPDATE OR DELETE ON "esign"."SignatureEvent"
  FOR EACH ROW EXECUTE FUNCTION esign.reject_signature_event_mutation();
