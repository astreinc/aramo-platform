-- SKILL-TAX-1F — SkillAuditEvent append-only enforcement at the DB.
--
-- The governance ledger must be immutable at the database, not merely insert-only
-- in the repository: reject every UPDATE and DELETE unconditionally (an audit row
-- is never mutated or removed post-insert). Mirrors the examination
-- CanonicalMatchShadowObservation + talent_trust append-only trigger pattern
-- (unconditional rejection, NOT a column-scoped OLD=NEW comparison, so nullable
-- columns are safe from the NULL=NULL first-row hazard).
--
-- Carries a dollar-quoted trigger body, so any integration spec applying this
-- migration MUST use a whole-file DDL applier (pg Client), never a naive line
-- splitter that breaks on statement separators.

CREATE OR REPLACE FUNCTION "skills_taxonomy"."reject_skill_audit_event_mutation"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'SkillAuditEvent is an append-only governance ledger (% rejected)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "skill_audit_event_no_update"
    BEFORE UPDATE ON "skills_taxonomy"."SkillAuditEvent"
    FOR EACH ROW
    EXECUTE FUNCTION "skills_taxonomy"."reject_skill_audit_event_mutation"();

CREATE TRIGGER "skill_audit_event_no_delete"
    BEFORE DELETE ON "skills_taxonomy"."SkillAuditEvent"
    FOR EACH ROW
    EXECUTE FUNCTION "skills_taxonomy"."reject_skill_audit_event_mutation"();
