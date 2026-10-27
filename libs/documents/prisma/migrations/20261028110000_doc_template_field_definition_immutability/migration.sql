-- Aramo Sign and Documents Amendment M-A6 v1.0 (LOCKED) §3.4 and §4.
-- TemplateFieldDefinition rows are template content: once their version leaves DRAFT
-- (ACTIVE or RETIRED) they are frozen, exactly like TemplateVersion.field_schema
-- (DOC-2 Invariant 5, trigger template_version_immutability).
--
-- A BEFORE INSERT / UPDATE / DELETE row trigger refuses the write unless the parent
-- TemplateVersion is DRAFT. An UPDATE checks BOTH the old and the new parent (a row can
-- never be moved out of, or into, a frozen version). The app-surface guard
-- (TemplatesRepository.addField refuses a non-DRAFT version) rides atop this.
--
-- A DELETE whose parent row is no longer visible is allowed: that is the ON DELETE
-- CASCADE of a DRAFT version being discarded (deleteDraftVersion), the only path that
-- deletes a version. Every other parent is visible and must be DRAFT.
--
-- ADD-only: no existing row, column or trigger changes. Rows already stored are not
-- touched. splitDdl-safe: no semicolons in comment lines.

CREATE OR REPLACE FUNCTION documents.enforce_template_field_definition_immutability()
RETURNS TRIGGER AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    SELECT v."status" INTO v_status FROM "documents"."TemplateVersion" v WHERE v."id" = NEW."template_version_id";
    IF v_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'TemplateFieldDefinition is immutable unless its TemplateVersion is DRAFT (M-A6 3.4), version status %', COALESCE(v_status, 'missing')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' OR TG_OP = 'DELETE' THEN
    SELECT v."status" INTO v_status FROM "documents"."TemplateVersion" v WHERE v."id" = OLD."template_version_id";
    IF FOUND AND v_status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'TemplateFieldDefinition is immutable unless its TemplateVersion is DRAFT (M-A6 3.4), version status %', v_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER template_field_definition_immutability
  BEFORE INSERT OR UPDATE OR DELETE ON "documents"."TemplateFieldDefinition"
  FOR EACH ROW EXECUTE FUNCTION documents.enforce_template_field_definition_immutability();
