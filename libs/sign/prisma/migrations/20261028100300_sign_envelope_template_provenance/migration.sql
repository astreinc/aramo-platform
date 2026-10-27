-- Aramo Sign and Documents — Amendment M-A6 v1.0 (LOCKED) §3.6 and §4.
-- Template provenance on an envelope started from a document template: the Documents
-- template and the exact template version the frozen document was rendered from.
-- Opaque UUID references (the documents schema is never joined from Sign): NO foreign
-- key, no cascade. Both are set together or not at all, and once set they never change
-- (written once, at from-template creation).
-- Additive only: two nullable columns, one CHECK, one trigger. Applied whole-file (the
-- trigger body is dollar-quoted).

ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "template_ref" UUID;
ALTER TABLE "sign"."SignatureEnvelope" ADD COLUMN "template_version_ref" UUID;
ALTER TABLE "sign"."SignatureEnvelope"
  ADD CONSTRAINT "SignatureEnvelope_template_provenance_pair_check"
  CHECK (("template_ref" IS NULL) = ("template_version_ref" IS NULL));

CREATE OR REPLACE FUNCTION "sign".signature_envelope_template_provenance_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.template_ref IS NOT NULL
     AND (NEW.template_ref IS DISTINCT FROM OLD.template_ref
          OR NEW.template_version_ref IS DISTINCT FROM OLD.template_version_ref) THEN
    RAISE EXCEPTION 'SignatureEnvelope template provenance is written once (M-A6 3.6)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER signature_envelope_template_provenance_immutable
  BEFORE UPDATE OF "template_ref", "template_version_ref" ON "sign"."SignatureEnvelope"
  FOR EACH ROW EXECUTE FUNCTION "sign".signature_envelope_template_provenance_immutable();
