-- FIELD-PARITY-2 (Aramo-Sign-Field-Placement-Conditional-Fields-Directive-v1_0-LOCKED) §4.2 B-2:
-- the condition of a field on sign.SignatureField. ADD-only (ADD-not-rename): the new column is NULL on every
-- existing row (an unconditional field, exactly as before).
--
--   condition  "show this field only when trigger field T ..." as one JSON object
--                { "trigger_key": T, "when": W, "values": [...] }
--              trigger_key  the trigger field's key (1 to 200 characters) (the envelope field_key, B-1)
--              when         checked | unchecked  (the trigger is a CHECKBOX or ACKNOWLEDGEMENT)
--                           chosen               (the trigger is one RADIO option)
--                           one_of               (the trigger is a DROPDOWN)
--              values       one_of only: 1 to 50 of the dropdown's choice values (text)
--              One trigger per field (ruling C-1: no AND / OR), chains up to a depth of 3, no
--              cycles, the trigger belongs to the same signer (C-2). The CHECK below holds the
--              shape. What needs the other fields (the trigger exists and has a type the rule
--              fits, the same signer, the values are its choices, no cycle, the depth, every
--              signer keeps an unconditional SIGNATURE) is the shared rule
--              @aramo/sign-fields fieldConditionIssues, run by every API that writes a field.
--
-- The same column and CHECK as the other field table (sign SignatureField and documents
-- TemplateFieldDefinition), held normalized-identical by
-- apps/api/src/tests/field-catalog-parity.spec.ts.
--
-- Idempotent (IF NOT EXISTS / DROP IF EXISTS). No row is updated. splitDdl-safe: no semicolons
-- in comment lines.

ALTER TABLE "sign"."SignatureField" ADD COLUMN IF NOT EXISTS "condition" JSONB;

ALTER TABLE "sign"."SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_condition_check";
ALTER TABLE "sign"."SignatureField"
  ADD CONSTRAINT "SignatureField_condition_check"
  CHECK (
    "condition" IS NULL
    OR (
      jsonb_typeof("condition") = 'object'
      AND ("condition" - 'trigger_key' - 'when' - 'values') = '{}'::jsonb
      AND COALESCE(jsonb_typeof("condition" -> 'trigger_key'), '') = 'string'
      AND char_length("condition" ->> 'trigger_key') BETWEEN 1 AND 200
      AND COALESCE("condition" ->> 'when', '') IN ('checked', 'unchecked', 'chosen', 'one_of')
      AND CASE
        WHEN "condition" ->> 'when' = 'one_of' THEN
          COALESCE(jsonb_typeof("condition" -> 'values'), '') = 'array'
          AND jsonb_array_length(CASE WHEN jsonb_typeof("condition" -> 'values') = 'array' THEN "condition" -> 'values' ELSE '[]'::jsonb END) BETWEEN 1 AND 50
          AND NOT jsonb_path_exists("condition", '$.values[*] ? (@.type() != "string")')
        ELSE ("condition" -> 'values') IS NULL
      END
    )
  );
