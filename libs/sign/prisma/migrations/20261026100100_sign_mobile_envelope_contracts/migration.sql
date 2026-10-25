-- Aramo Sign Mobile — envelope contracts (W2b).
-- Governing: Aramo-Sign-Unified-Product-Amendment-M-A3-Mobile-Owned-Data-Contracts-v1_0-LOCKED
-- §3 (sender message), §4 (saved signatures), §5 (contacts), §6 (revision validator),
-- §7/§8 (reminder limits, request idempotency) and
-- Aramo-Sign-Unified-Product-Amendment-M-A2-Mobile-Signing-Session-Deep-Links-v1_0-LOCKED
-- §2.2 (inbox signing never outlives the claimed link).
-- Additive only: new columns with defaults, new tables, new triggers. Applied
-- whole-file (the trigger bodies are dollar-quoted).

-- ── M-A3 §6 / §3 — revision validator and sender message ──────────────────────
ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "revision_txid" TEXT;
ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "message" TEXT;
ALTER TABLE "sign"."SignatureEnvelope"
  ADD CONSTRAINT "SignatureEnvelope_message_length_check" CHECK ("message" IS NULL OR char_length("message") <= 1000);

-- M-A2 §2.2 — the emailed session a recipient claim was made with (nullable: rows
-- claimed before this migration fall back to "the signer still holds a live link").
ALTER TABLE "sign"."SignRecipientBinding" ADD COLUMN "claim_session_id" UUID;

-- The revision is owned by the database. A new envelope starts at 1 and is stamped
-- with its creating transaction, so rows written in that same transaction do not
-- count. Every later transaction that updates the envelope row raises it by exactly
-- one, however many statements it runs. The application can never set it, and the
-- sender message can only change while the envelope is a DRAFT.
CREATE OR REPLACE FUNCTION "sign".signature_envelope_revision_insert()
RETURNS TRIGGER AS $$
BEGIN
  NEW.revision := 1;
  NEW.revision_txid := txid_current()::text;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER signature_envelope_revision_insert
  BEFORE INSERT ON "sign"."SignatureEnvelope"
  FOR EACH ROW EXECUTE FUNCTION "sign".signature_envelope_revision_insert();

CREATE OR REPLACE FUNCTION "sign".signature_envelope_revision_bump()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.message IS DISTINCT FROM OLD.message AND OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'SignatureEnvelope.message is immutable after send (M-A3 §3)' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revision_txid IS DISTINCT FROM txid_current()::text THEN
    NEW.revision := OLD.revision + 1;
    NEW.revision_txid := txid_current()::text;
  ELSE
    NEW.revision := OLD.revision;
    NEW.revision_txid := OLD.revision_txid;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER signature_envelope_revision_bump
  BEFORE UPDATE ON "sign"."SignatureEnvelope"
  FOR EACH ROW EXECUTE FUNCTION "sign".signature_envelope_revision_bump();

-- A write to any child row (documents, recipients, fields, disclosure acceptances,
-- ledger events) touches its envelope, which fires the bump above. The touch is a
-- no-op once the envelope was already raised in this transaction. Every signer and
-- sender path holds the envelope row lock (SELECT … FOR UPDATE) before writing a
-- child, so the touch adds no new lock ordering.
CREATE OR REPLACE FUNCTION "sign".signature_envelope_child_touch()
RETURNS TRIGGER AS $$
DECLARE
  env UUID;
BEGIN
  IF TG_TABLE_NAME = 'SignatureField' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT d.envelope_id INTO env FROM "sign"."EnvelopeDocument" d WHERE d.id = OLD.envelope_document_id;
    ELSE
      SELECT d.envelope_id INTO env FROM "sign"."EnvelopeDocument" d WHERE d.id = NEW.envelope_document_id;
    END IF;
  ELSIF TG_TABLE_NAME = 'SignerDisclosureAcceptance' THEN
    SELECT s.envelope_id INTO env FROM "sign"."Signer" s WHERE s.id = NEW.signer_id;
  ELSIF TG_OP = 'DELETE' THEN
    env := OLD.envelope_id;
  ELSE
    env := NEW.envelope_id;
  END IF;
  IF env IS NOT NULL THEN
    UPDATE "sign"."SignatureEnvelope" SET revision_txid = revision_txid
    WHERE id = env AND revision_txid IS DISTINCT FROM txid_current()::text;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER envelope_document_revision_touch
  AFTER INSERT OR UPDATE OR DELETE ON "sign"."EnvelopeDocument"
  FOR EACH ROW EXECUTE FUNCTION "sign".signature_envelope_child_touch();

CREATE TRIGGER signer_revision_touch
  AFTER INSERT OR UPDATE OR DELETE ON "sign"."Signer"
  FOR EACH ROW EXECUTE FUNCTION "sign".signature_envelope_child_touch();

CREATE TRIGGER signature_field_revision_touch
  AFTER INSERT OR UPDATE OR DELETE ON "sign"."SignatureField"
  FOR EACH ROW EXECUTE FUNCTION "sign".signature_envelope_child_touch();

CREATE TRIGGER signer_disclosure_revision_touch
  AFTER INSERT ON "sign"."SignerDisclosureAcceptance"
  FOR EACH ROW EXECUTE FUNCTION "sign".signature_envelope_child_touch();

CREATE TRIGGER signature_event_revision_touch
  AFTER INSERT ON "sign"."SignatureEvent"
  FOR EACH ROW EXECUTE FUNCTION "sign".signature_envelope_child_touch();

-- ── M-A3 §7 / §8 — request idempotency (remind, document upload) ──────────────
CREATE TABLE "sign"."SignIdempotencyKey" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignIdempotencyKey_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SignIdempotencyKey_key_length_check" CHECK (char_length("key") BETWEEN 1 AND 255)
);
CREATE UNIQUE INDEX "SignIdempotencyKey_scope_key" ON "sign"."SignIdempotencyKey"("tenant_id", "actor_id", "operation", "key");
CREATE INDEX "SignIdempotencyKey_created_at_idx" ON "sign"."SignIdempotencyKey"("created_at");

-- ── M-A3 §4 — saved signature defaults (user-deletable convenience data) ──────
CREATE TABLE "sign"."SignSavedSignature" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "slot" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "typed_name" TEXT,
    "font_key" TEXT,
    "image_data_url" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignSavedSignature_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SignSavedSignature_slot_check" CHECK ("slot" IN ('signature', 'initials')),
    CONSTRAINT "SignSavedSignature_kind_check" CHECK ("kind" IN ('TYPED', 'DRAWN')),
    CONSTRAINT "SignSavedSignature_image_check" CHECK ("image_data_url" ~ '^data:image/(png|jpeg);base64,' AND char_length("image_data_url") <= 400000)
);
CREATE UNIQUE INDEX "SignSavedSignature_owner_slot_key" ON "sign"."SignSavedSignature"("tenant_id", "user_id", "slot");

-- ── M-A3 §5 — private contacts per (tenant, owner user) ───────────────────────
CREATE TABLE "sign"."SignContact" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_key" TEXT NOT NULL,
    "organization" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ,
    CONSTRAINT "SignContact_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SignContact_email_key_check" CHECK ("email_key" = lower(btrim("email")))
);
CREATE UNIQUE INDEX "SignContact_owner_email_key" ON "sign"."SignContact"("tenant_id", "owner_user_id", "email_key");
CREATE INDEX "SignContact_tenant_id_owner_user_id_idx" ON "sign"."SignContact"("tenant_id", "owner_user_id");
