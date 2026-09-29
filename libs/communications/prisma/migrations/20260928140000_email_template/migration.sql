-- D-EMAIL-TPL-1 (ET-1) — reusable tenant email templates (communications domain).
-- ADDITIVE only: new enum + new table. Tenant-scoped, one override row per
-- (tenant_id, template_key) per D-1 Option C. Cross-schema tenant_id is UUID-only
-- (no FK) per doc/05-conventions.md. No data backfill — the code-owned default
-- (system.requisition-contact.v1) is the fallback when a tenant has no row.

CREATE TYPE "communications"."EmailTemplateCategory" AS ENUM ('requisition_initial_contact');

CREATE TABLE "communications"."EmailTemplate" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "template_key" TEXT NOT NULL,
    "category" "communications"."EmailTemplateCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "subject_template" TEXT NOT NULL,
    "body_template" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailTemplate_tenant_id_template_key_key" ON "communications"."EmailTemplate"("tenant_id", "template_key");
CREATE INDEX "EmailTemplate_tenant_id_category_idx" ON "communications"."EmailTemplate"("tenant_id", "category");
