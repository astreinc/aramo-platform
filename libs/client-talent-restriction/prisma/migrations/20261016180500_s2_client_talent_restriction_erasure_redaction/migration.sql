-- ARAMO-S2-Talent-Erasure-Integrity-Amendment-v1.0-LOCKED §3.3 (PO direction) —
-- ClientTalentRestriction (Track3-E7): under the subject-bound erasure
-- authorization (§2) the IDENTIFYING relationship may be removed, and nothing else:
--   talent_record_id → a fresh id that differs from the old one and resolves to
--                      no TalentRecord;
--   source_reference → 'erased:' || <uuid> (unique per row, so the assertion-
--                      identity unique key holds);
--   raw_source_value, asserting_organization_reference, asserting_contact_reference,
--   close_source_reference → NULL.
-- Every other column (client_company_id, restriction_type, reason_code, dates,
-- actors, closure) must be byte-unchanged. DELETE is not granted. Whether a
-- restriction MAY be erased is a retention decision: the erasure preflight keeps
-- every restriction BLOCKED (PENDING_PO_LEGAL) until Legal records the class.
-- The body after the erasure branch is the current E7 R4/R4b close-only function
-- unchanged.
CREATE OR REPLACE FUNCTION client_talent_restriction.reject_client_talent_restriction_update()
RETURNS TRIGGER AS $$
BEGIN
  IF COALESCE(current_setting('app.talent_erasure_run', true), '') <> '' THEN
    IF NEW.talent_record_id IS DISTINCT FROM OLD.talent_record_id
       AND NOT EXISTS (SELECT 1 FROM talent_record."TalentRecord" t WHERE t.id = NEW.talent_record_id)
       AND NEW.source_reference ~ '^erased:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND to_jsonb(NEW) = to_jsonb(OLD) || jsonb_build_object(
             'talent_record_id', NEW.talent_record_id, 'source_reference', NEW.source_reference,
             'raw_source_value', NULL, 'asserting_organization_reference', NULL,
             'asserting_contact_reference', NULL, 'close_source_reference', NULL)
       AND consent.s2_run_authorizes(OLD.tenant_id, OLD.talent_record_id)
    THEN
      RETURN NEW;
    END IF;
  END IF;
  IF (OLD.effective_to IS NULL AND NEW.effective_to IS NOT NULL
      AND OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL
      AND OLD.closed_by IS NULL AND NEW.closed_by IS NOT NULL
      AND OLD.close_reason_code IS NULL AND NEW.close_reason_code IS NOT NULL
      AND OLD.close_source_system IS NULL AND NEW.close_source_system IS NOT NULL
      AND OLD.close_source_reference IS NULL AND NEW.close_source_reference IS NOT NULL
      AND OLD.id = NEW.id
      AND OLD.tenant_id = NEW.tenant_id
      AND OLD.client_company_id = NEW.client_company_id
      AND OLD.talent_record_id = NEW.talent_record_id
      AND OLD.restriction_type = NEW.restriction_type
      AND OLD.asserted_by_type = NEW.asserted_by_type
      AND OLD.asserting_organization_reference IS NOT DISTINCT FROM NEW.asserting_organization_reference
      AND OLD.asserting_contact_reference IS NOT DISTINCT FROM NEW.asserting_contact_reference
      AND OLD.source_system = NEW.source_system
      AND OLD.source_reference = NEW.source_reference
      AND OLD.raw_source_value IS NOT DISTINCT FROM NEW.raw_source_value
      AND OLD.reason_code = NEW.reason_code
      AND OLD.recorded_by = NEW.recorded_by
      AND OLD.effective_from = NEW.effective_from
      AND OLD.scheduled_end_at IS NOT DISTINCT FROM NEW.scheduled_end_at
      AND OLD.recorded_at = NEW.recorded_at)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'ClientTalentRestriction is append-and-close-only per E7 R4/R4b -- the only permitted update is the atomic close writing effective_to with all five closure-provenance columns together -- reopening, partial closure, closure-field edits, and any change to scheduled_end_at, effective_from, assertion provenance, or the client/talent/type/idempotency identity are rejected'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;
