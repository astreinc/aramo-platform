-- Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED (2bd74ca5) §1.7 SMS delivery,
-- §1.8 WhatsApp delivery, §1.9 SMS OTP recipient verification, under Amendment A1
-- (dc95b283): built dark behind NOT_AVAILABLE, configured off.
-- ADDITIVE ONLY: four new tables. No existing table, column, constraint or trigger
-- changes, so the ledger (SignatureEvent) and its hash chain are untouched.
-- splitDdl-safe: no semicolons in comment lines.

-- The sender's messaging choice for one recipient. delivery_channel = the extra channel
-- (beside email) that carries the signing link. sms_otp_required = the recipient must
-- enter a one-time code sent to phone_e164 before acting. The row goes with the recipient.
CREATE TABLE "sign"."SignRecipientMessaging" (
  "signer_id"        UUID        NOT NULL,
  "tenant_id"        UUID        NOT NULL,
  "envelope_id"      UUID        NOT NULL,
  "delivery_channel" TEXT,
  "phone_e164"       TEXT        NOT NULL,
  "timezone"         TEXT,
  "sms_otp_required" BOOLEAN     NOT NULL DEFAULT false,
  "updated_by"       UUID        NOT NULL,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "SignRecipientMessaging_pkey" PRIMARY KEY ("signer_id"),
  CONSTRAINT "SignRecipientMessaging_signer_fkey" FOREIGN KEY ("signer_id") REFERENCES "sign"."Signer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SignRecipientMessaging_channel_check" CHECK ("delivery_channel" IS NULL OR "delivery_channel" IN ('SMS', 'WHATSAPP')),
  CONSTRAINT "SignRecipientMessaging_phone_check" CHECK ("phone_e164" ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT "SignRecipientMessaging_has_purpose_check" CHECK ("delivery_channel" IS NOT NULL OR "sms_otp_required"),
  CONSTRAINT "SignRecipientMessaging_timezone_check" CHECK ("timezone" IS NULL OR char_length("timezone") BETWEEN 1 AND 64)
);
CREATE INDEX "SignRecipientMessaging_envelope_idx" ON "sign"."SignRecipientMessaging" ("tenant_id", "envelope_id");

-- One row per outbound SMS or WhatsApp message (sent, failed or suppressed). Never the
-- number itself: its lookup hash and a masked form. Never the text or the link.
CREATE TABLE "sign"."SignMessageDelivery" (
  "id"                  UUID        NOT NULL,
  "tenant_id"           UUID        NOT NULL,
  "envelope_id"         UUID        NOT NULL,
  "signer_id"           UUID,
  "channel"             TEXT        NOT NULL,
  "purpose"             TEXT        NOT NULL,
  "status"              TEXT        NOT NULL,
  "suppressed_reason"   TEXT,
  "provider"            TEXT,
  "provider_message_id" TEXT,
  "phone_hash"          TEXT,
  "phone_masked"        TEXT,
  "error_code"          VARCHAR(64),
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
  "sent_at"             TIMESTAMPTZ,
  "status_updated_at"   TIMESTAMPTZ,
  CONSTRAINT "SignMessageDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignMessageDelivery_channel_check" CHECK ("channel" IN ('SMS', 'WHATSAPP')),
  CONSTRAINT "SignMessageDelivery_purpose_check" CHECK ("purpose" IN ('INVITATION', 'REMINDER', 'OTP')),
  CONSTRAINT "SignMessageDelivery_status_check" CHECK ("status" IN ('SENT', 'DELIVERED', 'READ', 'UNDELIVERED', 'FAILED', 'SUPPRESSED')),
  CONSTRAINT "SignMessageDelivery_suppressed_check" CHECK (
    ("status" = 'SUPPRESSED' AND "suppressed_reason" IN ('opted_out', 'rate_limited', 'quiet_hours', 'channel_unavailable'))
    OR ("status" <> 'SUPPRESSED' AND "suppressed_reason" IS NULL)
  )
);
CREATE INDEX "SignMessageDelivery_tenant_sent_idx" ON "sign"."SignMessageDelivery" ("tenant_id", "sent_at");
CREATE INDEX "SignMessageDelivery_envelope_idx" ON "sign"."SignMessageDelivery" ("tenant_id", "envelope_id");
CREATE INDEX "SignMessageDelivery_provider_ref_idx" ON "sign"."SignMessageDelivery" ("provider", "provider_message_id") WHERE "provider_message_id" IS NOT NULL;

-- The opt-out list (STOP). Platform-wide per number and channel: the sending number is
-- Aramo's, so a STOP applies to every tenant. Keyed by the number's lookup hash only.
CREATE TABLE "sign"."SignMessagingOptOut" (
  "phone_hash" TEXT        NOT NULL,
  "channel"    TEXT        NOT NULL,
  "opted_out"  BOOLEAN     NOT NULL,
  "source"     TEXT        NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "SignMessagingOptOut_pkey" PRIMARY KEY ("phone_hash", "channel"),
  CONSTRAINT "SignMessagingOptOut_channel_check" CHECK ("channel" IN ('SMS', 'WHATSAPP')),
  CONSTRAINT "SignMessagingOptOut_source_check" CHECK ("source" IN ('INBOUND_KEYWORD', 'PROVIDER'))
);

-- One SMS one-time code sent to a recipient for one signing session. Only the SHA-256 of
-- the code is kept. status ACTIVE until VERIFIED, EXPIRED, LOCKED (attempts used up) or
-- SUPERSEDED (a newer code was sent).
CREATE TABLE "sign"."SignRecipientOtpChallenge" (
  "id"           UUID        NOT NULL,
  "tenant_id"    UUID        NOT NULL,
  "envelope_id"  UUID        NOT NULL,
  "signer_id"    UUID        NOT NULL,
  "session_id"   UUID        NOT NULL,
  "phone_hash"   TEXT,
  "phone_masked" TEXT,
  "code_hash"    TEXT        NOT NULL,
  "status"       TEXT        NOT NULL DEFAULT 'ACTIVE',
  "attempts"     INTEGER     NOT NULL DEFAULT 0,
  "expires_at"   TIMESTAMPTZ NOT NULL,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "verified_at"  TIMESTAMPTZ,
  "locked_at"    TIMESTAMPTZ,
  CONSTRAINT "SignRecipientOtpChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignRecipientOtpChallenge_status_check" CHECK ("status" IN ('ACTIVE', 'VERIFIED', 'EXPIRED', 'LOCKED', 'SUPERSEDED')),
  CONSTRAINT "SignRecipientOtpChallenge_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "SignRecipientOtpChallenge_verified_check" CHECK (("status" = 'VERIFIED') = ("verified_at" IS NOT NULL))
);
CREATE INDEX "SignRecipientOtpChallenge_signer_idx" ON "sign"."SignRecipientOtpChallenge" ("tenant_id", "signer_id", "created_at");
CREATE INDEX "SignRecipientOtpChallenge_session_idx" ON "sign"."SignRecipientOtpChallenge" ("session_id");
