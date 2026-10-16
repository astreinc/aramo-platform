-- Document Templates slice 1 Phase B (B1) — TemplateVersion.internal_notes.
-- Admin-only notes about a template version (why it changed, who asked, etc.).
-- ADDITIVE + NULLABLE (DOC-TEMPLATE-ADMIN-RTR-1 §45): existing DocumentTemplate /
-- TemplateVersion / current_version_id / template_version_id are untouched; every
-- existing row (including the ACTIVE default v1) simply carries NULL. Never rendered
-- into any document. Bounded at 500 characters (DB CHECK backstops the API guard).
--
-- The TemplateVersion immutability trigger (DOC-2) guards UPDATEs of ACTIVE rows; an
-- ADD COLUMN with no default rewrites no rows and fires no row trigger.
ALTER TABLE "documents"."TemplateVersion" ADD COLUMN "internal_notes" TEXT;
ALTER TABLE "documents"."TemplateVersion"
  ADD CONSTRAINT "TemplateVersion_internal_notes_length_chk"
  CHECK ("internal_notes" IS NULL OR char_length("internal_notes") <= 500);
