-- Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED (2bd74ca5…) §1.16 (QES) and
-- §1.19 (stamp duty payment, India), under Amendment A1 (dc95b283…): vendor-neutral
-- ports and workflows, built DARK. No vendor is selected for either, so only disabled
-- adapters exist and the features stay NOT_AVAILABLE (R-2, R-8).
--
-- ADDITIVE: two new tables. No existing table, column, constraint or trigger changes.
-- Both tables cascade with their envelope (and the QES row with its signer), so a draft
-- whose recipients are replaced or deleted loses its QES requirement with them.

-- ── §1.16 QES: one signer's qualified signature through a QTSP ───────────────
CREATE TABLE "sign"."SignQesSignature" (
    "id"                       UUID NOT NULL,
    "tenant_id"                UUID NOT NULL,
    "envelope_id"              UUID NOT NULL,
    "signer_id"                UUID NOT NULL,
    "signature_level"          TEXT NOT NULL DEFAULT 'QES',
    "state"                    TEXT NOT NULL DEFAULT 'REQUIRED',
    "provider"                 TEXT,
    "pending_state_sha256"     TEXT,
    "credential_id"            TEXT,
    "certificate_chain_pem"    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "certificate_chain_sha256" TEXT,
    "authorization_level"      TEXT,
    "hash_algorithm_oid"       TEXT,
    "signature_algorithm_oid"  TEXT,
    "signed_digest_b64"        TEXT,
    "signature_value_b64"      TEXT,
    "signature_sha256"         TEXT,
    "qtsp_reference"           TEXT,
    "failure_reason"           TEXT,
    "requested_by"             UUID NOT NULL,
    "created_at"               TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"               TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "identity_started_at"      TIMESTAMPTZ,
    "authorized_at"            TIMESTAMPTZ,
    "signed_at"                TIMESTAMPTZ,
    "failed_at"                TIMESTAMPTZ,

    CONSTRAINT "SignQesSignature_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SignQesSignature_level_check" CHECK ("signature_level" IN ('QES')),
    CONSTRAINT "SignQesSignature_state_check"
      CHECK ("state" IN ('REQUIRED', 'IDENTITY_PROOFING_PENDING', 'AUTHORIZED', 'SIGNED', 'FAILED')),
    -- A credential and its certificate chain are known from AUTHORIZED on.
    CONSTRAINT "SignQesSignature_authorized_check"
      CHECK ("state" NOT IN ('AUTHORIZED', 'SIGNED')
             OR ("credential_id" IS NOT NULL AND "certificate_chain_sha256" IS NOT NULL
                 AND cardinality("certificate_chain_pem") >= 1 AND "authorized_at" IS NOT NULL)),
    -- A signed row carries the signature evidence.
    CONSTRAINT "SignQesSignature_signed_check"
      CHECK ("state" <> 'SIGNED'
             OR ("signature_value_b64" IS NOT NULL AND "signature_sha256" IS NOT NULL
                 AND "signed_digest_b64" IS NOT NULL AND "hash_algorithm_oid" IS NOT NULL
                 AND "signature_algorithm_oid" IS NOT NULL AND "signed_at" IS NOT NULL)),
    CONSTRAINT "SignQesSignature_failed_check"
      CHECK ("state" <> 'FAILED' OR ("failure_reason" IS NOT NULL AND "failed_at" IS NOT NULL))
);

CREATE UNIQUE INDEX "SignQesSignature_signer_id_key" ON "sign"."SignQesSignature" ("signer_id");
CREATE INDEX "SignQesSignature_envelope_idx" ON "sign"."SignQesSignature" ("tenant_id", "envelope_id");

ALTER TABLE "sign"."SignQesSignature"
  ADD CONSTRAINT "SignQesSignature_envelope_id_fkey" FOREIGN KEY ("envelope_id")
  REFERENCES "sign"."SignatureEnvelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sign"."SignQesSignature"
  ADD CONSTRAINT "SignQesSignature_signer_id_fkey" FOREIGN KEY ("signer_id")
  REFERENCES "sign"."Signer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A SIGNED qualified signature is evidence: it is never changed afterwards.
CREATE OR REPLACE FUNCTION "sign".reject_signed_qes_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."state" = 'SIGNED' THEN
    RAISE EXCEPTION 'SignQesSignature % is SIGNED and immutable', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER qes_signature_signed_immutable
  BEFORE UPDATE ON "sign"."SignQesSignature"
  FOR EACH ROW EXECUTE FUNCTION "sign".reject_signed_qes_mutation();

-- ── §1.19 India e-stamp: an e-stamp paper placed in front of the documents ───
CREATE TABLE "sign"."SignEstampOrder" (
    "id"                         UUID NOT NULL,
    "tenant_id"                  UUID NOT NULL,
    "envelope_id"                UUID NOT NULL,
    "state"                      TEXT NOT NULL DEFAULT 'REQUESTED',
    "provider"                   TEXT NOT NULL,
    "provider_order_ref"         TEXT,
    "state_code"                 TEXT NOT NULL,
    "article_code"               TEXT NOT NULL,
    "stamp_duty_amount_paise"    BIGINT NOT NULL,
    "consideration_amount_paise" BIGINT,
    "first_party"                TEXT NOT NULL,
    "second_party"               TEXT NOT NULL,
    "purchaser"                  TEXT NOT NULL,
    "description"                TEXT,
    "certificate_number"         TEXT,
    "certificate_issued_at"      TIMESTAMPTZ,
    "certificate_sha256"         TEXT,
    "certificate_object_key"     TEXT,
    "certificate_page_count"     INTEGER,
    "attached_document_id"       UUID,
    "failure_reason"             TEXT,
    "requested_by"               UUID NOT NULL,
    "created_at"                 TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                 TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ordered_at"                 TIMESTAMPTZ,
    "attached_at"                TIMESTAMPTZ,
    "failed_at"                  TIMESTAMPTZ,

    CONSTRAINT "SignEstampOrder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SignEstampOrder_state_check"
      CHECK ("state" IN ('REQUESTED', 'ORDERED', 'ISSUED', 'ATTACHED', 'FAILED')),
    CONSTRAINT "SignEstampOrder_state_code_check" CHECK ("state_code" ~ '^IN-[A-Z]{2}$'),
    CONSTRAINT "SignEstampOrder_duty_check" CHECK ("stamp_duty_amount_paise" > 0),
    CONSTRAINT "SignEstampOrder_consideration_check"
      CHECK ("consideration_amount_paise" IS NULL OR "consideration_amount_paise" >= 0),
    CONSTRAINT "SignEstampOrder_text_check"
      CHECK (length(btrim("article_code")) BETWEEN 1 AND 120
             AND length(btrim("first_party")) BETWEEN 1 AND 200
             AND length(btrim("second_party")) BETWEEN 1 AND 200
             AND length(btrim("purchaser")) BETWEEN 1 AND 200
             AND ("description" IS NULL OR length("description") <= 500)),
    CONSTRAINT "SignEstampOrder_ordered_check"
      CHECK ("state" IN ('REQUESTED', 'FAILED') OR ("provider_order_ref" IS NOT NULL AND "ordered_at" IS NOT NULL)),
    -- The certificate is known from ISSUED on (the attached document may later be removed
    -- from a draft — SET NULL — and the send guard then refuses the envelope).
    CONSTRAINT "SignEstampOrder_issued_check"
      CHECK ("state" NOT IN ('ISSUED', 'ATTACHED')
             OR ("certificate_number" IS NOT NULL AND "certificate_issued_at" IS NOT NULL
                 AND "certificate_sha256" IS NOT NULL AND "certificate_object_key" IS NOT NULL
                 AND "certificate_page_count" >= 1)),
    CONSTRAINT "SignEstampOrder_attached_check" CHECK ("state" <> 'ATTACHED' OR "attached_at" IS NOT NULL),
    CONSTRAINT "SignEstampOrder_failed_check"
      CHECK ("state" <> 'FAILED' OR ("failure_reason" IS NOT NULL AND "failed_at" IS NOT NULL))
);

CREATE INDEX "SignEstampOrder_envelope_idx" ON "sign"."SignEstampOrder" ("tenant_id", "envelope_id");
-- At most one live (non-FAILED) e-stamp order per envelope.
CREATE UNIQUE INDEX "SignEstampOrder_live_envelope_key" ON "sign"."SignEstampOrder" ("envelope_id") WHERE "state" <> 'FAILED';

ALTER TABLE "sign"."SignEstampOrder"
  ADD CONSTRAINT "SignEstampOrder_envelope_id_fkey" FOREIGN KEY ("envelope_id")
  REFERENCES "sign"."SignatureEnvelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sign"."SignEstampOrder"
  ADD CONSTRAINT "SignEstampOrder_attached_document_id_fkey" FOREIGN KEY ("attached_document_id")
  REFERENCES "sign"."EnvelopeDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;
