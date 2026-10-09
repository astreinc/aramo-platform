-- DOC-TEMPLATE-ADMIN-RTR-1 — tenant Document Template administration substrate.
-- Additive only (§45): existing DocumentTemplate / TemplateVersion / current_version_id
-- / template_version_id provenance are preserved untouched; new columns are nullable
-- with no destructive backfill. The existing ACTIVE "Standard Right to Represent" v1
-- row stays valid (its new columns are simply NULL).

-- 1. Activation actor provenance (§21). TemplateVersion.activated_by records WHO
--    approved & activated the version (the activation is a single event; created_by
--    is NOT reused as approved_by). Nullable — historical activations (pre-feature)
--    have no recorded actor and stay NULL.
ALTER TABLE "documents"."TemplateVersion" ADD COLUMN "activated_by" UUID;

-- 2. Preview-revision gate (§18). content_fingerprint is a deterministic hash of the
--    version's current editable content (field_schema); previewed_fingerprint is the
--    content_fingerprint captured at the last admin preview. Activation requires
--    content_fingerprint = previewed_fingerprint, so editing after preview re-arms the
--    gate. Both nullable (a legacy ACTIVE version carries neither and is never edited).
ALTER TABLE "documents"."TemplateVersion" ADD COLUMN "content_fingerprint" TEXT;
ALTER TABLE "documents"."TemplateVersion" ADD COLUMN "previewed_fingerprint" TEXT;

-- 3. One-DRAFT invariant (§41), DB-enforced. At most one open DRAFT version per
--    template — a partial unique index on (tenant_id, template_id) WHERE status='DRAFT'.
--    This is the race backstop: two concurrent "Create new version" requests cannot
--    both land a DRAFT (the second hits a unique violation, mapped to
--    TEMPLATE_DRAFT_ALREADY_EXISTS). The app-surface guard returns the existing draft
--    on the happy path. Scoped by tenant_id for defense-in-depth tenant isolation.
CREATE UNIQUE INDEX "TemplateVersion_one_draft_per_template"
  ON "documents"."TemplateVersion" ("tenant_id", "template_id")
  WHERE "status" = 'DRAFT';
