-- Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED (2bd74ca5…) §1.9 recipient
-- verification (government ID and KBA), under Amendment A1 (dc95b283…): built DARK behind a
-- vendor-neutral port. sign.id_verification and sign.kba stay NOT_AVAILABLE and the
-- providers stay unset until the PO authorizes go-live (A1.2).
--
-- R-5: raw ID images and document data stay at the vendor. Aramo keeps only the outcome,
-- the vendor's session reference, whether the verified name matched the recipient, and the
-- issuing country of the document. Retention follows the Sign purge (the REDACT level
-- clears document_country and failure_reason and sets redacted_at).
--
-- ADDITIVE ONLY: two new nullable Signer columns, one new table, and one widened
-- NotificationDelivery CHECK. No existing row changes. The append-only SignatureEvent
-- ledger is untouched (the new event types are ordinary appended rows).
-- splitDdl-safe: no semicolons in comment lines.

-- The sender's per-recipient verification method. Other authentication methods of §1.9
-- (ACCESS_CODE, SMS_OTP) are separate columns owned by their own migrations.
-- Link recipients only: never a copy recipient, never an in-person signer (the host is
-- present).
ALTER TABLE "sign"."Signer" ADD COLUMN IF NOT EXISTS "identity_verification_method" TEXT;
ALTER TABLE "sign"."Signer" ADD COLUMN IF NOT EXISTS "identity_verification_locked_at" TIMESTAMPTZ;
ALTER TABLE "sign"."Signer" DROP CONSTRAINT IF EXISTS "Signer_identity_verification_method_check";
ALTER TABLE "sign"."Signer"
  ADD CONSTRAINT "Signer_identity_verification_method_check" CHECK (
    "identity_verification_method" IS NULL
    OR ("identity_verification_method" IN ('ID_VERIFICATION', 'KBA') AND "recipient_kind" NOT IN ('RECEIVES_COPY', 'IN_PERSON_SIGNER'))
  );

-- One row per verification attempt. The outcome, never the document.
CREATE TABLE "sign"."SignRecipientIdentityVerification" (
    "id"               UUID NOT NULL,
    "tenant_id"        UUID NOT NULL,
    "envelope_id"      UUID NOT NULL,
    "signer_id"        UUID NOT NULL,
    "session_id"       UUID NOT NULL,
    "method"           TEXT NOT NULL,
    "provider"         TEXT NOT NULL,
    "vendor_reference" TEXT,
    "status"           TEXT NOT NULL DEFAULT 'PENDING',
    "failure_reason"   TEXT,
    "name_match"       BOOLEAN,
    "document_country" TEXT,
    "created_at"       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at"     TIMESTAMPTZ,
    "redacted_at"      TIMESTAMPTZ,

    CONSTRAINT "SignRecipientIdentityVerification_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SignRecipientIdentityVerification_method_check" CHECK ("method" IN ('ID_VERIFICATION', 'KBA')),
    CONSTRAINT "SignRecipientIdentityVerification_status_check" CHECK ("status" IN ('PENDING', 'VERIFIED', 'FAILED', 'CANCELLED')),
    -- Terminal outcomes carry completed_at. PENDING does not.
    CONSTRAINT "SignRecipientIdentityVerification_completed_check" CHECK (("status" = 'PENDING') = ("completed_at" IS NULL)),
    -- VERIFIED means the name matched. A name mismatch is a FAILED outcome.
    CONSTRAINT "SignRecipientIdentityVerification_verified_check" CHECK ("status" <> 'VERIFIED' OR "name_match" = true),
    CONSTRAINT "SignRecipientIdentityVerification_failure_reason_check" CHECK ("failure_reason" IS NULL OR char_length("failure_reason") <= 64),
    CONSTRAINT "SignRecipientIdentityVerification_country_check" CHECK ("document_country" IS NULL OR "document_country" ~ '^[A-Z]{2}$'),
    CONSTRAINT "SignRecipientIdentityVerification_signer_fkey" FOREIGN KEY ("signer_id")
      REFERENCES "sign"."Signer" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SignRecipientIdentityVerification_vendor_reference_key"
  ON "sign"."SignRecipientIdentityVerification" ("provider", "vendor_reference");
CREATE INDEX "SignRecipientIdentityVerification_signer_idx"
  ON "sign"."SignRecipientIdentityVerification" ("tenant_id", "signer_id");
CREATE INDEX "SignRecipientIdentityVerification_envelope_idx"
  ON "sign"."SignRecipientIdentityVerification" ("tenant_id", "envelope_id");

-- The sender hears that a recipient failed verification (conservative name-mismatch policy).
ALTER TABLE "sign"."NotificationDelivery" DROP CONSTRAINT "NotificationDelivery_kind_check";
ALTER TABLE "sign"."NotificationDelivery"
  ADD CONSTRAINT "NotificationDelivery_kind_check"
  CHECK ("notification_kind" IN ('SIGNATURE_REQUEST', 'SIGNATURE_REMINDER', 'SIGNATURE_COMPLETED', 'SIGNATURE_DECLINED', 'SIGNATURE_EXPIRED', 'SIGNATURE_VOIDED', 'SIGNER_SIGNED', 'RECIPIENT_COPY', 'IDENTITY_VERIFICATION_FAILED'));
