-- Aramo-DOC-TEMPLATE-LIB-1 (Shared Document Template Library) v1.0 LOCKED — increment T-1, §3.
-- Governing ADR: Aramo-ADR-0034-Shared-Document-Template-Library-v1_0-LOCKED (O-5 precondition).
-- Conforming amendment row 1 (DOC-2) + row 2 (DOC v1.1 invariant 8 refined, not relaxed).
--
-- Database foundation ONLY. Behaviour-neutral for existing tenants: every existing
-- DocumentTemplate becomes owner_scope = 'TENANT' through the column DEFAULT (no row is
-- rewritten to PLATFORM here), no selection is backfilled, the RTR sentinel conversion
-- is T-3, and TemplateVariable is not yet read by any code (T-2 wires it).
-- splitDdl-safe: no semicolons in comment lines.

-- ── 1. DocumentTemplate — PLATFORM | TENANT ownership ─────────────────────────
ALTER TABLE "documents"."DocumentTemplate"
  ADD COLUMN "owner_scope" TEXT NOT NULL DEFAULT 'TENANT';
ALTER TABLE "documents"."DocumentTemplate"
  ADD CONSTRAINT "DocumentTemplate_owner_scope_check" CHECK ("owner_scope" IN ('PLATFORM', 'TENANT'));
ALTER TABLE "documents"."DocumentTemplate" ALTER COLUMN "tenant_id" DROP NOT NULL;
-- tenant_id is NULL if and only if the row is an Aramo (PLATFORM) default.
ALTER TABLE "documents"."DocumentTemplate"
  ADD CONSTRAINT "DocumentTemplate_owner_tenant_check" CHECK (("owner_scope" = 'PLATFORM') = ("tenant_id" IS NULL));
-- A PLATFORM default is never client-specific.
ALTER TABLE "documents"."DocumentTemplate"
  ADD CONSTRAINT "DocumentTemplate_platform_no_client_check" CHECK ("owner_scope" = 'TENANT' OR "client_id" IS NULL);
-- Product tags (ADR-0034 D9) + withdrawal timestamps (D10) — PLATFORM rows only.
ALTER TABLE "documents"."DocumentTemplate" ADD COLUMN "products" TEXT[];
ALTER TABLE "documents"."DocumentTemplate" ADD COLUMN "withdraw_notice_at" TIMESTAMPTZ;
ALTER TABLE "documents"."DocumentTemplate" ADD COLUMN "withdraw_effective_at" TIMESTAMPTZ;
ALTER TABLE "documents"."DocumentTemplate"
  ADD CONSTRAINT "DocumentTemplate_products_platform_only_check" CHECK ("owner_scope" = 'PLATFORM' OR "products" IS NULL);
ALTER TABLE "documents"."DocumentTemplate"
  ADD CONSTRAINT "DocumentTemplate_withdraw_platform_only_check"
  CHECK ("owner_scope" = 'PLATFORM' OR ("withdraw_notice_at" IS NULL AND "withdraw_effective_at" IS NULL));
CREATE INDEX "DocumentTemplate_owner_scope_document_type_id_idx"
  ON "documents"."DocumentTemplate" ("owner_scope", "document_type_id");

-- ── 2. TemplateVersion.tenant_id — nullable, always equal to the parent's ────
ALTER TABLE "documents"."TemplateVersion" ALTER COLUMN "tenant_id" DROP NOT NULL;

CREATE OR REPLACE FUNCTION documents.enforce_template_version_tenant_matches_template()
RETURNS TRIGGER AS $$
DECLARE
  v_found BOOLEAN;
  v_parent_tenant UUID;
BEGIN
  SELECT true, t."tenant_id" INTO v_found, v_parent_tenant
    FROM "documents"."DocumentTemplate" t WHERE t."id" = NEW."template_id";
  IF v_found IS NULL THEN
    -- Unknown parent: the template_id FK reports it.
    RETURN NEW;
  END IF;
  IF NEW."tenant_id" IS DISTINCT FROM v_parent_tenant THEN
    RAISE EXCEPTION 'TemplateVersion.tenant_id must equal its DocumentTemplate.tenant_id (DOC-TEMPLATE-LIB-1 T-1)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER template_version_tenant_matches_template
  BEFORE INSERT OR UPDATE ON "documents"."TemplateVersion"
  FOR EACH ROW EXECUTE FUNCTION documents.enforce_template_version_tenant_matches_template();

-- ── 3. One-DRAFT invariant also holds for PLATFORM (NULL tenant) templates ───
-- Postgres treats NULLs as distinct by default, so the original partial unique index
-- would stop enforcing anything for tenant_id NULL. Rebuilt NULLS NOT DISTINCT (PG15+,
-- production and local run PG17). The index NAME is unchanged because
-- templates.repository.ts maps the violation by name to TEMPLATE_DRAFT_ALREADY_EXISTS.
DROP INDEX "documents"."TemplateVersion_one_draft_per_template";
CREATE UNIQUE INDEX "TemplateVersion_one_draft_per_template"
  ON "documents"."TemplateVersion" ("tenant_id", "template_id") NULLS NOT DISTINCT
  WHERE "status" = 'DRAFT';

-- ── 4. Immutability — tenant_id + template_id frozen on EVERY update, and the
--       ACTIVE freeze also covers RETIRED rows ─────────────────────────────────
-- Unchanged from DOC-2 R-2-3 for DRAFT rows (content stays editable, DRAFT to ACTIVE
-- activation sets activated_at, activated_by and the fingerprints) and for the
-- ACTIVE to RETIRED transition (status + retired_at). The admin columns added later
-- (activated_by, content_fingerprint, previewed_fingerprint, internal_notes) are not
-- content and keep their existing (unconstrained by this trigger) behaviour.
-- RETIRED is terminal: its content is frozen and its status may not move.
CREATE OR REPLACE FUNCTION documents.enforce_template_version_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
     OR NEW."template_id" IS DISTINCT FROM OLD."template_id" THEN
    RAISE EXCEPTION 'TemplateVersion tenant_id and template_id are immutable (DOC-TEMPLATE-LIB-1 T-1)';
  END IF;
  IF OLD."status" IN ('ACTIVE', 'RETIRED') THEN
    IF NEW."field_schema" IS DISTINCT FROM OLD."field_schema"
       OR NEW."binding_schema" IS DISTINCT FROM OLD."binding_schema"
       OR NEW."render_schema_version" IS DISTINCT FROM OLD."render_schema_version"
       OR NEW."source_artifact_id" IS DISTINCT FROM OLD."source_artifact_id"
       OR NEW."version_number" IS DISTINCT FROM OLD."version_number" THEN
      RAISE EXCEPTION 'TemplateVersion is immutable after activation (DOC-2 R-2-3): content fields cannot change once ACTIVE or RETIRED';
    END IF;
  END IF;
  IF OLD."status" = 'ACTIVE' AND NEW."status" NOT IN ('ACTIVE', 'RETIRED') THEN
    RAISE EXCEPTION 'TemplateVersion ACTIVE may only transition to RETIRED (DOC-2 R-2-3), got %', NEW."status";
  END IF;
  IF OLD."status" = 'RETIRED' AND NEW."status" <> 'RETIRED' THEN
    RAISE EXCEPTION 'TemplateVersion RETIRED is terminal (DOC-TEMPLATE-LIB-1 T-1), got %', NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- The trigger template_version_immutability (DOC-2) already executes this function.

-- ── 5. TemplateAsset stays tenant-only [TD] — no change ──────────────────────

-- ── 6. TenantTemplateSelection — the explicit active choice per type + client ─
CREATE TABLE "documents"."TenantTemplateSelection" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "document_type_id" UUID NOT NULL,
  "client_id" UUID,
  "template_id" UUID NOT NULL,
  "selected_by" UUID NOT NULL,
  "selected_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "TenantTemplateSelection_pkey" PRIMARY KEY ("id")
);
-- One selection per (tenant, type, client) with the tenant-wide (NULL client) row
-- unique too.
CREATE UNIQUE INDEX "TenantTemplateSelection_tenant_type_client_key"
  ON "documents"."TenantTemplateSelection" ("tenant_id", "document_type_id", "client_id") NULLS NOT DISTINCT;
CREATE INDEX "TenantTemplateSelection_tenant_id_idx" ON "documents"."TenantTemplateSelection" ("tenant_id");
CREATE INDEX "TenantTemplateSelection_template_id_idx" ON "documents"."TenantTemplateSelection" ("template_id");
ALTER TABLE "documents"."TenantTemplateSelection"
  ADD CONSTRAINT "TenantTemplateSelection_document_type_id_fkey"
  FOREIGN KEY ("document_type_id") REFERENCES "documents"."DocumentType" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents"."TenantTemplateSelection"
  ADD CONSTRAINT "TenantTemplateSelection_template_id_fkey"
  FOREIGN KEY ("template_id") REFERENCES "documents"."DocumentTemplate" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION documents.enforce_tenant_template_selection_target()
RETURNS TRIGGER AS $$
DECLARE
  v_found BOOLEAN;
  v_owner TEXT;
  v_tenant UUID;
  v_type UUID;
BEGIN
  SELECT true, t."owner_scope", t."tenant_id", t."document_type_id" INTO v_found, v_owner, v_tenant, v_type
    FROM "documents"."DocumentTemplate" t WHERE t."id" = NEW."template_id";
  IF v_found IS NULL THEN
    -- Unknown template: the template_id FK reports it.
    RETURN NEW;
  END IF;
  IF NOT (v_owner = 'PLATFORM' OR (v_owner = 'TENANT' AND v_tenant = NEW."tenant_id")) THEN
    RAISE EXCEPTION 'TenantTemplateSelection.template_id must be a PLATFORM template or a TENANT template of the same tenant (DOC-TEMPLATE-LIB-1 T-1)';
  END IF;
  IF v_type IS DISTINCT FROM NEW."document_type_id" THEN
    RAISE EXCEPTION 'TenantTemplateSelection.template_id must be of the selected document type (DOC-TEMPLATE-LIB-1 T-1)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenant_template_selection_target
  BEFORE INSERT OR UPDATE ON "documents"."TenantTemplateSelection"
  FOR EACH ROW EXECUTE FUNCTION documents.enforce_tenant_template_selection_target();

-- ── 7. TemplateVariable — the Aramo-maintained variable catalog (ADR-0034 D7) ─
-- Platform-maintained: NO tenant_id. No column name carries the S2 holder-coverage
-- token (s2-erasure-integrity.integration.spec.ts holder-coverage test).
CREATE TABLE "documents"."TemplateVariable" (
  "id" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "group_label" TEXT NOT NULL,
  "data_type" TEXT NOT NULL,
  "products" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "ats_binding_key" TEXT,
  "sample_value" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "TemplateVariable_pkey" PRIMARY KEY ("id"),
  -- Value-carrying subset of the TemplateFieldDefinition field types.
  CONSTRAINT "TemplateVariable_data_type_check" CHECK ("data_type" IN ('TEXT', 'MULTILINE_TEXT', 'DATE', 'NUMBER', 'CURRENCY'))
);
CREATE UNIQUE INDEX "TemplateVariable_key_key" ON "documents"."TemplateVariable" ("key");

-- Seed — the 8 RTR binding keys of apps/api/src/rtr/rtr-template-content.ts
-- (RTR_BINDING_CATALOG: key, label, group, fixed safe preview sample), products ATS.
-- Idempotent (ON CONFLICT on the unique key).
INSERT INTO "documents"."TemplateVariable" ("id", "key", "label", "group_label", "data_type", "products", "ats_binding_key", "sample_value")
VALUES
  (gen_random_uuid(), 'talent.full_name', 'Talent full name', 'Talent', 'TEXT', ARRAY['ATS'], 'talent.full_name', 'Ravi Shankar'),
  (gen_random_uuid(), 'talent.desired_pay_rate', 'Desired pay rate', 'Talent', 'TEXT', ARRAY['ATS'], 'talent.desired_pay_rate', '$70/hr'),
  (gen_random_uuid(), 'client.name', 'Client name', 'Client', 'TEXT', ARRAY['ATS'], 'client.name', 'Mindlance'),
  (gen_random_uuid(), 'requisition.title', 'Requisition title', 'Requisition', 'TEXT', ARRAY['ATS'], 'requisition.title', 'Business Analyst - Multi-Family'),
  (gen_random_uuid(), 'requisition.reference', 'Requisition reference', 'Requisition', 'TEXT', ARRAY['ATS'], 'requisition.reference', 'REQ-1001'),
  (gen_random_uuid(), 'requisition.description', 'Job description', 'Requisition', 'MULTILINE_TEXT', ARRAY['ATS'], 'requisition.description',
    E'Analyze business requirements for multi-family housing programs.\n\nPartner with stakeholders to define scope and acceptance criteria.'),
  (gen_random_uuid(), 'recruiting_company.name', 'Recruiting company', 'Recruiting organization', 'TEXT', ARRAY['ATS'], 'recruiting_company.name', 'Astre Consulting'),
  (gen_random_uuid(), 'recruiter.display_name', 'Recruiter name', 'Recruiter', 'TEXT', ARRAY['ATS'], 'recruiter.display_name', 'Deepika Rao')
ON CONFLICT ("key") DO NOTHING;
