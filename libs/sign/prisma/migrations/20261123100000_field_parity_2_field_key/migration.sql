-- FIELD-PARITY-2 (Aramo-Sign-Field-Placement-Conditional-Fields-Directive-v1_0-LOCKED) §4.2 B-1:
-- a stable field key on sign.SignatureField. ADD-only (ADD-not-rename): the new column is NULL on
-- every existing row (a legacy field has no key and cannot be a condition's trigger).
--
--   field_key  the field's stable key on its envelope (1 to 200 characters). Set from the
--              template's field_key when a template is carried onto an envelope, and from the
--              editor's id when a sender saves (PUT …/fields). It survives the replace-all PUT,
--              which re-creates the rows with new ids, so a condition (B-2) names its trigger by
--              key, never by id.
--
-- Uniqueness: a key is unique per envelope when present. A field row reaches its envelope only
-- through its document (envelope_document_id), and a Postgres unique index cannot span that join,
-- so the guarantee has two parts.
--   1. The partial unique index below: unique per document when present (the database backstop).
--   2. Per envelope: every write that sets a key writes the whole field list of the envelope in
--      ONE transaction under the envelope's revision check (the replace-all PUT and the template
--      carry), and the shared rule (@aramo/sign-fields fieldConditionIssues) refuses a key that
--      appears twice in that list (field_key_duplicate) before anything is written.
-- A trigger was not added: no other path writes a key, and a cross-document trigger would need a
-- lock on the envelope row that every field write already takes.
--
-- Idempotent (IF NOT EXISTS / DROP IF EXISTS). No row is updated. splitDdl-safe: no semicolons
-- in comment lines.

ALTER TABLE "sign"."SignatureField" ADD COLUMN IF NOT EXISTS "field_key" TEXT;

ALTER TABLE "sign"."SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_field_key_check";
ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_field_key_check"
  CHECK ("field_key" IS NULL OR char_length("field_key") BETWEEN 1 AND 200);

CREATE UNIQUE INDEX IF NOT EXISTS "SignatureField_document_field_key"
  ON "sign"."SignatureField" ("envelope_document_id", "field_key")
  WHERE "field_key" IS NOT NULL;
