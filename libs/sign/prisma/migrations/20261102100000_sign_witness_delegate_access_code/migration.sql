-- Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED (2bd74ca5…) §1.17 witness and
-- delegate signing, §1.9 recipient verification (the access code part). Built DARK: the
-- features sign.witness_signing, sign.delegate_signing and sign.access_code stay
-- NOT_AVAILABLE until the PO authorizes the flip (R-8).
--
-- ADDITIVE ONLY: one recipient kind, new nullable columns, new CHECKs, one deferred
-- composite FK and one new guard trigger. No existing guard function is replaced, no
-- existing row changes, and the append-only SignatureEvent ledger is untouched (the new
-- event types are ordinary appended rows hashed by the existing chain).
-- splitDdl-safe: no semicolons in comment lines.

-- ── §1.17 witness ────────────────────────────────────────────────────────────
-- A WITNESS is a signing recipient tied to exactly one other signing recipient of the
-- same envelope, who attests after that signer signs.
ALTER TABLE "sign"."Signer" DROP CONSTRAINT "Signer_recipient_kind_check";
ALTER TABLE "sign"."Signer"
  ADD CONSTRAINT "Signer_recipient_kind_check" CHECK ("recipient_kind" IN ('SIGNER', 'IN_PERSON_SIGNER', 'RECEIVES_COPY', 'WITNESS'));

ALTER TABLE "sign"."Signer" ADD COLUMN "witness_for_signer_id" UUID;
-- Set if, and only if, the recipient is a WITNESS, and never the witness itself.
ALTER TABLE "sign"."Signer"
  ADD CONSTRAINT "Signer_witness_for_check" CHECK (
    (("recipient_kind" = 'WITNESS') = ("witness_for_signer_id" IS NOT NULL))
    AND ("witness_for_signer_id" IS NULL OR "witness_for_signer_id" <> "id")
  );
-- The witnessed signer is on the SAME envelope (composite FK). Deferred so the
-- replace-all recipients write may create a witness and its signer in one transaction.
CREATE UNIQUE INDEX "Signer_envelope_id_id_key" ON "sign"."Signer" ("envelope_id", "id");
ALTER TABLE "sign"."Signer"
  ADD CONSTRAINT "Signer_witness_for_fkey" FOREIGN KEY ("envelope_id", "witness_for_signer_id")
  REFERENCES "sign"."Signer" ("envelope_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX "Signer_witness_for_signer_id_idx" ON "sign"."Signer" ("witness_for_signer_id") WHERE "witness_for_signer_id" IS NOT NULL;

-- ── §1.17 delegate ───────────────────────────────────────────────────────────
-- The sender allows delegation per envelope. Set in DRAFT only (guard below).
ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "allow_delegation" BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION "sign".signature_envelope_allow_delegation_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.allow_delegation IS DISTINCT FROM OLD.allow_delegation AND OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'SignatureEnvelope.allow_delegation is immutable after send' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER signature_envelope_allow_delegation_immutable
  BEFORE UPDATE ON "sign"."SignatureEnvelope"
  FOR EACH ROW EXECUTE FUNCTION "sign".signature_envelope_allow_delegation_immutable();

-- The original recipient of a delegated SIGNER slot (the slot now names the delegate).
-- All three are set together, once, and only on a SIGNER.
ALTER TABLE "sign"."Signer" ADD COLUMN "delegated_from_name" TEXT;
ALTER TABLE "sign"."Signer" ADD COLUMN "delegated_from_email" TEXT;
ALTER TABLE "sign"."Signer" ADD COLUMN "delegated_at" TIMESTAMPTZ;
ALTER TABLE "sign"."Signer"
  ADD CONSTRAINT "Signer_delegation_check" CHECK (
    ("delegated_at" IS NULL AND "delegated_from_name" IS NULL AND "delegated_from_email" IS NULL)
    OR ("delegated_at" IS NOT NULL AND "delegated_from_name" IS NOT NULL AND "delegated_from_email" IS NOT NULL AND "recipient_kind" = 'SIGNER')
  );

-- ── §1.9 access code ─────────────────────────────────────────────────────────
-- Only a salted scrypt hash is stored (never the code). Link recipients only (SIGNER,
-- WITNESS). Failed attempts are counted per recipient and lock the recipient out.
ALTER TABLE "sign"."Signer" ADD COLUMN "access_code_hash" TEXT;
ALTER TABLE "sign"."Signer" ADD COLUMN "access_code_failed_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "sign"."Signer" ADD COLUMN "access_code_locked_at" TIMESTAMPTZ;
ALTER TABLE "sign"."Signer"
  ADD CONSTRAINT "Signer_access_code_check" CHECK (
    ("access_code_hash" IS NULL OR ("recipient_kind" IN ('SIGNER', 'WITNESS') AND "access_code_hash" LIKE 'scrypt$%'))
    AND "access_code_failed_count" >= 0
  );

-- A signing session is cleared to view once its recipient entered the access code.
ALTER TABLE "sign"."SigningSession" ADD COLUMN "access_code_verified_at" TIMESTAMPTZ;
