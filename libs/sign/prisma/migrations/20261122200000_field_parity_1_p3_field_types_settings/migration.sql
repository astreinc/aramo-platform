-- FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §6 Phase 3:
-- new field types and field settings on sign.SignatureField. ADD-only (ADD-not-rename): every
-- existing row keeps its meaning — the new columns are NULL (or false) on every existing row,
-- and each widened CHECK accepts a superset of what it accepted before.
--
-- 1. Field types (T-3..T-7): DATE, DROPDOWN, RADIO, NUMBER, MULTILINE_TEXT join the type CHECK
--    (the @aramo/sign-fields catalog's sign_store projection, held equal by
--    apps/api/src/tests/field-catalog-parity.spec.ts).
-- 2. Settings (S-1..S-7, S-9), nullable / defaulted columns:
--      tooltip        S-1: hint shown to the signer (1 to 500 characters)
--      placeholder    S-2: hint text in an empty field (1 to 200 characters)
--      read_only      S-4: the signer may not change the value (only with sender_filled)
--      sender_filled  S-5: the sender types the value before sending (dark: the server flag
--                     SIGN_SENDER_FILLED_FIELDS_ENABLED, ruling R-3)
--      validation     S-6: email | phone | us_zip | max_length (TEXT), max_length
--                     (MULTILINE_TEXT), number_range (NUMBER), date_range (DATE)
--      font_size      S-7: fixed size in points (6 to 36), NULL = auto (the P0-2 stamper)
--      data_name      S-9: a stable lower_snake key per field
--      options        the per-type options as one JSON object (DROPDOWN choices, NUMBER format,
--                     the validation parameters). One JSON column rather than eight sparse
--                     columns: the DROPDOWN choices are a variable-length list, and each type
--                     takes a different small set of keys (the shared rule
--                     parseFieldSettings validates the shape, the CHECK keeps it an object).
-- 3. label (S-1) applies to every type: label_check drops its CHECKBOX-only clause (the length
--    rule stays). group_key / group_rule apply to RADIO too: a RADIO always has a group whose
--    rule is SELECT_ONE (one option of an exactly-one group, built on the check-box SELECT_ONE
--    group). A DROPDOWN always carries options.choices.
--
-- Idempotent (IF NOT EXISTS / DROP IF EXISTS). No row is updated. splitDdl-safe: no semicolons
-- in comment lines.

ALTER TABLE "sign"."SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_type_check";
ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_type_check"
  CHECK ("field_type" IN ('SIGNATURE', 'SIGN_DATE', 'INITIALS', 'TEXT', 'SIGNER_NAME', 'CHECKBOX',
                          'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'COMPANY', 'TITLE', 'ACKNOWLEDGEMENT', 'PAYMENT',
                          'DATE', 'DROPDOWN', 'RADIO', 'NUMBER', 'MULTILINE_TEXT'));

ALTER TABLE "sign"."SignatureField" ADD COLUMN IF NOT EXISTS "tooltip" TEXT;
ALTER TABLE "sign"."SignatureField" ADD COLUMN IF NOT EXISTS "placeholder" TEXT;
ALTER TABLE "sign"."SignatureField" ADD COLUMN IF NOT EXISTS "read_only" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sign"."SignatureField" ADD COLUMN IF NOT EXISTS "sender_filled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "sign"."SignatureField" ADD COLUMN IF NOT EXISTS "validation" TEXT;
ALTER TABLE "sign"."SignatureField" ADD COLUMN IF NOT EXISTS "font_size" INTEGER;
ALTER TABLE "sign"."SignatureField" ADD COLUMN IF NOT EXISTS "data_name" TEXT;
ALTER TABLE "sign"."SignatureField" ADD COLUMN IF NOT EXISTS "options" JSONB;

ALTER TABLE "sign"."SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_label_check";
ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_label_check"
  CHECK ("label" IS NULL OR char_length("label") BETWEEN 1 AND 200);

ALTER TABLE "sign"."SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_group_key_check";
ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_group_key_check"
  CHECK ("group_key" IS NULL OR ("field_type" IN ('CHECKBOX', 'RADIO') AND char_length("group_key") BETWEEN 1 AND 64));

ALTER TABLE "sign"."SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_radio_group_check";
ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_radio_group_check"
  CHECK ("field_type" <> 'RADIO' OR ("group_key" IS NOT NULL AND "group_rule" = 'SELECT_ONE' AND "min_selected" IS NULL));

ALTER TABLE "sign"."SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_dropdown_choices_check";
ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_dropdown_choices_check"
  CHECK ("field_type" <> 'DROPDOWN' OR COALESCE(jsonb_typeof("options" -> 'choices'), '') = 'array');

ALTER TABLE "sign"."SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_tooltip_check";
ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_tooltip_check"
  CHECK ("tooltip" IS NULL OR char_length("tooltip") BETWEEN 1 AND 500);

ALTER TABLE "sign"."SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_placeholder_check";
ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_placeholder_check"
  CHECK ("placeholder" IS NULL OR char_length("placeholder") BETWEEN 1 AND 200);

ALTER TABLE "sign"."SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_read_only_check";
ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_read_only_check"
  CHECK (NOT "read_only" OR "sender_filled");

ALTER TABLE "sign"."SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_sender_filled_check";
ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_sender_filled_check"
  CHECK (NOT "sender_filled" OR "field_type" IN ('TEXT', 'CHECKBOX', 'DATE', 'DROPDOWN', 'RADIO', 'NUMBER', 'MULTILINE_TEXT'));

ALTER TABLE "sign"."SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_validation_check";
ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_validation_check"
  CHECK (
    "validation" IS NULL
    OR ("field_type" = 'TEXT' AND "validation" IN ('email', 'phone', 'us_zip', 'max_length'))
    OR ("field_type" = 'MULTILINE_TEXT' AND "validation" = 'max_length')
    OR ("field_type" = 'NUMBER' AND "validation" = 'number_range')
    OR ("field_type" = 'DATE' AND "validation" = 'date_range')
  );

ALTER TABLE "sign"."SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_font_size_check";
ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_font_size_check"
  CHECK ("font_size" IS NULL OR "font_size" BETWEEN 6 AND 36);

ALTER TABLE "sign"."SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_data_name_check";
ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_data_name_check"
  CHECK ("data_name" IS NULL OR "data_name" ~ '^[a-z][a-z0-9_]{0,63}$');

ALTER TABLE "sign"."SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_options_check";
ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_options_check"
  CHECK ("options" IS NULL OR jsonb_typeof("options") = 'object');
