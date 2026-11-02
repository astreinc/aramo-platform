-- Aramo-TEMPLATE-PRODUCT-1 (Document Types, Product Tags, Fixed Forms and Personal Studio)
-- Implementation Directive v1.0 LOCKED — increment TP-6, §7.3.
--
-- NEW table documents.TenantTemplateVisibility (ADD): a tenant's Hide / Show choice for an
-- Aramo fixed form. A fixed form is never adopted, it is shown to every entitled tenant by
-- default, so only a tenant that changed the default has a row. Columns exactly
-- (tenant_id, template_id, hidden, updated_by, updated_at), primary key (tenant_id,
-- template_id). template_id FK to DocumentTemplate ON DELETE CASCADE (a row only exists for
-- a published default, which is never deleted, so this only keeps the TP-2 delete path free
-- of a dangling reference). The application writes rows for PLATFORM fixed forms only.
--
-- One DO block. Idempotent: every step checks the catalog first.
-- splitDdl-safe: no semicolons in comment lines.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema = 'documents' AND table_name = 'TenantTemplateVisibility') THEN
    CREATE TABLE "documents"."TenantTemplateVisibility" (
      "tenant_id"   UUID        NOT NULL,
      "template_id" UUID        NOT NULL,
      "hidden"      BOOLEAN     NOT NULL DEFAULT false,
      "updated_by"  UUID        NOT NULL,
      "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT "TenantTemplateVisibility_pkey" PRIMARY KEY ("tenant_id", "template_id")
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'TenantTemplateVisibility_template_id_fkey') THEN
    ALTER TABLE "documents"."TenantTemplateVisibility"
      ADD CONSTRAINT "TenantTemplateVisibility_template_id_fkey"
      FOREIGN KEY ("template_id") REFERENCES "documents"."DocumentTemplate" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'documents' AND indexname = 'TenantTemplateVisibility_template_id_idx') THEN
    CREATE INDEX "TenantTemplateVisibility_template_id_idx" ON "documents"."TenantTemplateVisibility" ("template_id");
  END IF;
END
$$;
