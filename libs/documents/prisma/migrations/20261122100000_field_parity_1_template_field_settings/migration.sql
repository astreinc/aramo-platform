-- FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §4 P1-3:
-- templates carry the field settings Aramo Sign has. documents.TemplateFieldDefinition gains
-- the five sign.SignatureField setting columns (M-A6 §2, migration
-- libs/sign/prisma/migrations/20261028100200_sign_field_name_checkbox_config), with the SAME
-- type-scoped CHECKs, so a template field carries onto an envelope field unchanged (P1-4).
--
--   name_mode     SIGNER_NAME only: SIGNER_PROFILE (Sign fills the signer's name) or
--                 SIGNER_ENTERED (the signer types it). NULL = the default (SIGNER_PROFILE,
--                 exactly what a template SIGNER_NAME field has always become in Sign).
--   label         CHECKBOX only: the box's caption (1 to 200 characters).
--   group_key     CHECKBOX only: boxes of one signer role sharing a key form a group.
--   group_rule    CHECKBOX only, present exactly when group_key is: SELECT_ONE or SELECT_ANY.
--   min_selected  CHECKBOX groups only: at least 1, and 1 for SELECT_ONE (NULL = 1).
--
-- ADD-only and nullable: every existing row carries NULL everywhere and behaves exactly as
-- before. No existing row, column, CHECK or trigger changes. ALTER TABLE ADD COLUMN fires no
-- row trigger, so the M-A6 immutability trigger (template_field_definition_immutability)
-- stays as is: a published (ACTIVE / RETIRED) version keeps its fields frozen, and settings
-- are written only with the field rows of a DRAFT version.
--
-- Idempotent (IF NOT EXISTS and catalog checks). splitDdl-safe: no semicolons in comment lines.

ALTER TABLE "documents"."TemplateFieldDefinition" ADD COLUMN IF NOT EXISTS "label" TEXT;
ALTER TABLE "documents"."TemplateFieldDefinition" ADD COLUMN IF NOT EXISTS "group_key" TEXT;
ALTER TABLE "documents"."TemplateFieldDefinition" ADD COLUMN IF NOT EXISTS "group_rule" TEXT;
ALTER TABLE "documents"."TemplateFieldDefinition" ADD COLUMN IF NOT EXISTS "min_selected" INTEGER;
ALTER TABLE "documents"."TemplateFieldDefinition" ADD COLUMN IF NOT EXISTS "name_mode" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TemplateFieldDefinition_name_mode_check') THEN
    ALTER TABLE "documents"."TemplateFieldDefinition"
      ADD CONSTRAINT "TemplateFieldDefinition_name_mode_check"
      CHECK ("name_mode" IS NULL OR ("field_type" = 'SIGNER_NAME' AND "name_mode" IN ('SIGNER_PROFILE', 'SIGNER_ENTERED')));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TemplateFieldDefinition_label_check') THEN
    ALTER TABLE "documents"."TemplateFieldDefinition"
      ADD CONSTRAINT "TemplateFieldDefinition_label_check"
      CHECK ("label" IS NULL OR ("field_type" = 'CHECKBOX' AND char_length("label") BETWEEN 1 AND 200));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TemplateFieldDefinition_group_key_check') THEN
    ALTER TABLE "documents"."TemplateFieldDefinition"
      ADD CONSTRAINT "TemplateFieldDefinition_group_key_check"
      CHECK ("group_key" IS NULL OR ("field_type" = 'CHECKBOX' AND char_length("group_key") BETWEEN 1 AND 64));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TemplateFieldDefinition_group_rule_check') THEN
    ALTER TABLE "documents"."TemplateFieldDefinition"
      ADD CONSTRAINT "TemplateFieldDefinition_group_rule_check"
      CHECK (
        ("group_key" IS NULL AND "group_rule" IS NULL)
        OR ("group_key" IS NOT NULL AND "group_rule" IS NOT NULL AND "group_rule" IN ('SELECT_ONE', 'SELECT_ANY'))
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TemplateFieldDefinition_min_selected_check') THEN
    ALTER TABLE "documents"."TemplateFieldDefinition"
      ADD CONSTRAINT "TemplateFieldDefinition_min_selected_check"
      CHECK (
        "min_selected" IS NULL
        OR ("group_key" IS NOT NULL AND "min_selected" >= 1 AND (COALESCE("group_rule", '') <> 'SELECT_ONE' OR "min_selected" = 1))
      );
  END IF;
END $$;
