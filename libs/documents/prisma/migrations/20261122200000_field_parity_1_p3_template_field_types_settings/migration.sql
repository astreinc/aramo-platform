-- FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §6 Phase 3,
-- ruling R-1: a template carries every field type and setting a send can (P1-3). On
-- documents.TemplateFieldDefinition:
--
-- 1. The field-type CHECK gains the Sign types a template field may now be: DROPDOWN, RADIO,
--    ACKNOWLEDGEMENT (R-2) and the profile types FIRST_NAME, LAST_NAME, EMAIL, COMPANY, TITLE
--    (T-1). DATE, NUMBER and MULTILINE_TEXT were already in it. CURRENCY, IMAGE and
--    SIGNER_EMAIL stay (R-9: CURRENCY and SIGNER_EMAIL are mapped onto an envelope, IMAGE is
--    retired from authoring by the API and existing rows stay readable). The list is the
--    @aramo/sign-fields catalog's template_documents_store projection, held equal by
--    apps/api/src/tests/field-catalog-parity.spec.ts.
-- 2. The same eight setting columns as the Sign field table (its Phase 3 migration
--    libs/sign/prisma/migrations/20261122200000_field_parity_1_p3_field_types_settings), with
--    the same CHECKs: tooltip, placeholder, read_only, sender_filled, validation, font_size,
--    data_name, options (one JSON object of per-type options: DROPDOWN choices, NUMBER format,
--    the validation parameters).
-- 3. label applies to every type (label_check drops its CHECKBOX-only clause), group_key
--    applies to RADIO too, and a RADIO always has a SELECT_ONE group. A DROPDOWN always
--    carries options.choices.
--
-- ADD-only (ADD-not-rename). Every existing row keeps its meaning: the new columns are NULL or
-- false and each widened CHECK accepts a superset of before. ALTER TABLE (ADD COLUMN with a
-- constant default, ADD / DROP CONSTRAINT) fires no row trigger, so the M-A6 immutability
-- trigger (template_field_definition_immutability) is untouched: a published (ACTIVE / RETIRED)
-- version keeps its fields frozen, and the new settings are written only with the field rows of
-- a DRAFT version.
--
-- Idempotent (IF NOT EXISTS / DROP IF EXISTS). No row is updated. splitDdl-safe: no semicolons
-- in comment lines, no dollar-quoted blocks.

ALTER TABLE "documents"."TemplateFieldDefinition" DROP CONSTRAINT IF EXISTS "TemplateFieldDefinition_type_check";
ALTER TABLE "documents"."TemplateFieldDefinition"
  ADD CONSTRAINT "TemplateFieldDefinition_type_check"
  CHECK ("field_type" IN ('SIGNATURE', 'SIGN_DATE', 'INITIALS', 'TEXT', 'SIGNER_NAME', 'CHECKBOX',
                          'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'COMPANY', 'TITLE', 'ACKNOWLEDGEMENT',
                          'DATE', 'DROPDOWN', 'RADIO', 'NUMBER', 'MULTILINE_TEXT', 'CURRENCY', 'IMAGE', 'SIGNER_EMAIL'));

ALTER TABLE "documents"."TemplateFieldDefinition" ADD COLUMN IF NOT EXISTS "tooltip" TEXT;
ALTER TABLE "documents"."TemplateFieldDefinition" ADD COLUMN IF NOT EXISTS "placeholder" TEXT;
ALTER TABLE "documents"."TemplateFieldDefinition" ADD COLUMN IF NOT EXISTS "read_only" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "documents"."TemplateFieldDefinition" ADD COLUMN IF NOT EXISTS "sender_filled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "documents"."TemplateFieldDefinition" ADD COLUMN IF NOT EXISTS "validation" TEXT;
ALTER TABLE "documents"."TemplateFieldDefinition" ADD COLUMN IF NOT EXISTS "font_size" INTEGER;
ALTER TABLE "documents"."TemplateFieldDefinition" ADD COLUMN IF NOT EXISTS "data_name" TEXT;
ALTER TABLE "documents"."TemplateFieldDefinition" ADD COLUMN IF NOT EXISTS "options" JSONB;

ALTER TABLE "documents"."TemplateFieldDefinition" DROP CONSTRAINT IF EXISTS "TemplateFieldDefinition_label_check";
ALTER TABLE "documents"."TemplateFieldDefinition"
  ADD CONSTRAINT "TemplateFieldDefinition_label_check"
  CHECK ("label" IS NULL OR char_length("label") BETWEEN 1 AND 200);

ALTER TABLE "documents"."TemplateFieldDefinition" DROP CONSTRAINT IF EXISTS "TemplateFieldDefinition_group_key_check";
ALTER TABLE "documents"."TemplateFieldDefinition"
  ADD CONSTRAINT "TemplateFieldDefinition_group_key_check"
  CHECK ("group_key" IS NULL OR ("field_type" IN ('CHECKBOX', 'RADIO') AND char_length("group_key") BETWEEN 1 AND 64));

ALTER TABLE "documents"."TemplateFieldDefinition" DROP CONSTRAINT IF EXISTS "TemplateFieldDefinition_radio_group_check";
ALTER TABLE "documents"."TemplateFieldDefinition"
  ADD CONSTRAINT "TemplateFieldDefinition_radio_group_check"
  CHECK ("field_type" <> 'RADIO' OR ("group_key" IS NOT NULL AND "group_rule" = 'SELECT_ONE' AND "min_selected" IS NULL));

ALTER TABLE "documents"."TemplateFieldDefinition" DROP CONSTRAINT IF EXISTS "TemplateFieldDefinition_dropdown_choices_check";
ALTER TABLE "documents"."TemplateFieldDefinition"
  ADD CONSTRAINT "TemplateFieldDefinition_dropdown_choices_check"
  CHECK ("field_type" <> 'DROPDOWN' OR COALESCE(jsonb_typeof("options" -> 'choices'), '') = 'array');

ALTER TABLE "documents"."TemplateFieldDefinition" DROP CONSTRAINT IF EXISTS "TemplateFieldDefinition_tooltip_check";
ALTER TABLE "documents"."TemplateFieldDefinition"
  ADD CONSTRAINT "TemplateFieldDefinition_tooltip_check"
  CHECK ("tooltip" IS NULL OR char_length("tooltip") BETWEEN 1 AND 500);

ALTER TABLE "documents"."TemplateFieldDefinition" DROP CONSTRAINT IF EXISTS "TemplateFieldDefinition_placeholder_check";
ALTER TABLE "documents"."TemplateFieldDefinition"
  ADD CONSTRAINT "TemplateFieldDefinition_placeholder_check"
  CHECK ("placeholder" IS NULL OR char_length("placeholder") BETWEEN 1 AND 200);

ALTER TABLE "documents"."TemplateFieldDefinition" DROP CONSTRAINT IF EXISTS "TemplateFieldDefinition_read_only_check";
ALTER TABLE "documents"."TemplateFieldDefinition"
  ADD CONSTRAINT "TemplateFieldDefinition_read_only_check"
  CHECK (NOT "read_only" OR "sender_filled");

ALTER TABLE "documents"."TemplateFieldDefinition" DROP CONSTRAINT IF EXISTS "TemplateFieldDefinition_sender_filled_check";
ALTER TABLE "documents"."TemplateFieldDefinition"
  ADD CONSTRAINT "TemplateFieldDefinition_sender_filled_check"
  CHECK (NOT "sender_filled" OR "field_type" IN ('TEXT', 'CHECKBOX', 'DATE', 'DROPDOWN', 'RADIO', 'NUMBER', 'MULTILINE_TEXT'));

ALTER TABLE "documents"."TemplateFieldDefinition" DROP CONSTRAINT IF EXISTS "TemplateFieldDefinition_validation_check";
ALTER TABLE "documents"."TemplateFieldDefinition"
  ADD CONSTRAINT "TemplateFieldDefinition_validation_check"
  CHECK (
    "validation" IS NULL
    OR ("field_type" = 'TEXT' AND "validation" IN ('email', 'phone', 'us_zip', 'max_length'))
    OR ("field_type" = 'MULTILINE_TEXT' AND "validation" = 'max_length')
    OR ("field_type" = 'NUMBER' AND "validation" = 'number_range')
    OR ("field_type" = 'DATE' AND "validation" = 'date_range')
  );

ALTER TABLE "documents"."TemplateFieldDefinition" DROP CONSTRAINT IF EXISTS "TemplateFieldDefinition_font_size_check";
ALTER TABLE "documents"."TemplateFieldDefinition"
  ADD CONSTRAINT "TemplateFieldDefinition_font_size_check"
  CHECK ("font_size" IS NULL OR "font_size" BETWEEN 6 AND 36);

ALTER TABLE "documents"."TemplateFieldDefinition" DROP CONSTRAINT IF EXISTS "TemplateFieldDefinition_data_name_check";
ALTER TABLE "documents"."TemplateFieldDefinition"
  ADD CONSTRAINT "TemplateFieldDefinition_data_name_check"
  CHECK ("data_name" IS NULL OR "data_name" ~ '^[a-z][a-z0-9_]{0,63}$');

ALTER TABLE "documents"."TemplateFieldDefinition" DROP CONSTRAINT IF EXISTS "TemplateFieldDefinition_options_check";
ALTER TABLE "documents"."TemplateFieldDefinition"
  ADD CONSTRAINT "TemplateFieldDefinition_options_check"
  CHECK ("options" IS NULL OR jsonb_typeof("options") = 'object');
