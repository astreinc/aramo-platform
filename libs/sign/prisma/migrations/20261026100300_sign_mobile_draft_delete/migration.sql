-- Aramo Sign Mobile — delete a DRAFT envelope (W7, D-W6-3).
-- Governing: Aramo-Sign-Mobile-Native-Application-Implementation-Directive-v1_0-LOCKED
-- §5 (create and save drafts) and Aramo-Sign-Unified-Product-Amendment-M-A3 §6
-- (If-Match on draft writes).
-- Additive only: one new nullable column, one CHECK, one trigger. Applied whole-file
-- (the trigger body is dollar-quoted).
--
-- Every envelope has ledger events from its creation (ENVELOPE_CREATED, and
-- DOCUMENT_ATTACHED / DOCUMENT_REMOVED while drafting), and SignatureEvent is
-- append-only with an ON DELETE RESTRICT reference to its envelope. So a deleted
-- draft cannot be a removed row: its documents, recipients and fields are deleted,
-- its stored source objects removed, its subject and message scrubbed, and the
-- envelope row stays behind as a tombstone with deleted_at set, which no read of the
-- Sign console returns. A draft never holds signing evidence (it was never sent).
ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "deleted_at" TIMESTAMPTZ;

-- Only a DRAFT is ever deleted, and a deleted draft can never be sent or moved on.
ALTER TABLE "sign"."SignatureEnvelope"
  ADD CONSTRAINT "SignatureEnvelope_deleted_draft_check" CHECK ("deleted_at" IS NULL OR "status" = 'DRAFT');

-- Deletion is final: once set, deleted_at never changes or clears.
CREATE OR REPLACE FUNCTION "sign".signature_envelope_deleted_final()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'SignatureEnvelope.deleted_at is final' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER signature_envelope_deleted_final
  BEFORE UPDATE ON "sign"."SignatureEnvelope"
  FOR EACH ROW EXECUTE FUNCTION "sign".signature_envelope_deleted_final();
