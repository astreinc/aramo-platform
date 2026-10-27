-- Aramo Sign — Name and Checkbox field configuration (M-A6 §2).
-- Governing: Aramo-Sign-Documents-Amendment-M-A6-Field-Types-Multi-Role-Templates-v1_0-LOCKED
-- §2 (SIGNER_NAME name_mode; CHECKBOX label and grouping) and §4 (this migration).
-- Additive only: five new nullable columns on SignatureField and one type-scoped
-- CHECK per column. Existing rows (and fields created through the S2S and Sign API
-- paths, which keep all seven engine types) carry NULL everywhere and behave
-- exactly as before.
--
--   name_mode     SIGNER_NAME only: SIGNER_PROFILE (the server fills the value from
--                 the signer's name; a client value is refused) or SIGNER_ENTERED
--                 (the signer types it). NULL = legacy engine field (signer-entered).
--   label         CHECKBOX only: the box's caption, printed in the certificate.
--   group_key     CHECKBOX only: boxes of one signer sharing a key form a group.
--   group_rule    CHECKBOX only, present exactly when group_key is: SELECT_ONE
--                 (exactly one box checked) or SELECT_ANY.
--   min_selected  CHECKBOX groups only: the boxes a required group needs checked
--                 (default 1 when NULL); always 1 for SELECT_ONE.
ALTER TABLE "sign"."SignatureField" ADD COLUMN "label" TEXT;
ALTER TABLE "sign"."SignatureField" ADD COLUMN "group_key" TEXT;
ALTER TABLE "sign"."SignatureField" ADD COLUMN "group_rule" TEXT;
ALTER TABLE "sign"."SignatureField" ADD COLUMN "min_selected" INTEGER;
ALTER TABLE "sign"."SignatureField" ADD COLUMN "name_mode" TEXT;

ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_name_mode_check"
  CHECK ("name_mode" IS NULL OR ("field_type" = 'SIGNER_NAME' AND "name_mode" IN ('SIGNER_PROFILE', 'SIGNER_ENTERED')));

ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_label_check"
  CHECK ("label" IS NULL OR ("field_type" = 'CHECKBOX' AND char_length("label") BETWEEN 1 AND 200));

ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_group_key_check"
  CHECK ("group_key" IS NULL OR ("field_type" = 'CHECKBOX' AND char_length("group_key") BETWEEN 1 AND 64));

ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_group_rule_check"
  CHECK (
    ("group_key" IS NULL AND "group_rule" IS NULL)
    OR ("group_key" IS NOT NULL AND "group_rule" IS NOT NULL AND "group_rule" IN ('SELECT_ONE', 'SELECT_ANY'))
  );

ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_min_selected_check"
  CHECK (
    "min_selected" IS NULL
    OR ("group_key" IS NOT NULL AND "min_selected" >= 1 AND (COALESCE("group_rule", '') <> 'SELECT_ONE' OR "min_selected" = 1))
  );
