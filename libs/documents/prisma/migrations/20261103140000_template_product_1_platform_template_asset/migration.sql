-- Aramo-TEMPLATE-PRODUCT-1 (Document Types, Product Tags, Fixed Forms and Personal Studio)
-- Implementation Directive v1.0 LOCKED — increment TP-6, §7.1.
--
-- NEW table documents.PlatformTemplateAsset (ADD): the official PDF of an Aramo fixed form,
-- uploaded by Platform Admin to a DRAFT version of a PLATFORM default. TemplateAsset stays
-- tenant-only (DOC-TEMPLATE-LIB-1 unchanged in substance). The object lives under the
-- platform prefix documents/platform/ of the existing documents bucket.
--   PDF only (mime CHECK), at most 10 MB (byte_size CHECK), at least one page, a lowercase
--   hex sha256, a platform storage key.
--   template_version_id FK to TemplateVersion ON DELETE CASCADE: discarding a DRAFT (the only
--   version that can be deleted) removes the asset row with it.
--   A row is written once: UPDATE is refused, and INSERT is refused unless the version is a
--   PLATFORM version (tenant_id NULL) that is still DRAFT.
--
-- One DO block plus the trigger function. Idempotent: every step checks the catalog first.
-- splitDdl-safe: no semicolons in comment lines.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema = 'documents' AND table_name = 'PlatformTemplateAsset') THEN
    CREATE TABLE "documents"."PlatformTemplateAsset" (
      "id"                  UUID        NOT NULL,
      "template_version_id" UUID        NOT NULL,
      "storage_key"         TEXT        NOT NULL,
      "mime"                TEXT        NOT NULL,
      "sha256"              TEXT        NOT NULL,
      "byte_size"           INTEGER     NOT NULL,
      "page_count"          INTEGER     NOT NULL,
      "created_at"          TIMESTAMPTZ NOT NULL DEFAULT now(),
      "created_by"          UUID        NOT NULL,
      CONSTRAINT "PlatformTemplateAsset_pkey" PRIMARY KEY ("id")
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PlatformTemplateAsset_template_version_id_fkey') THEN
    ALTER TABLE "documents"."PlatformTemplateAsset"
      ADD CONSTRAINT "PlatformTemplateAsset_template_version_id_fkey"
      FOREIGN KEY ("template_version_id") REFERENCES "documents"."TemplateVersion" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PlatformTemplateAsset_mime_check') THEN
    ALTER TABLE "documents"."PlatformTemplateAsset"
      ADD CONSTRAINT "PlatformTemplateAsset_mime_check" CHECK ("mime" = 'application/pdf');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PlatformTemplateAsset_byte_size_check') THEN
    ALTER TABLE "documents"."PlatformTemplateAsset"
      ADD CONSTRAINT "PlatformTemplateAsset_byte_size_check" CHECK ("byte_size" > 0 AND "byte_size" <= 10485760);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PlatformTemplateAsset_page_count_check') THEN
    ALTER TABLE "documents"."PlatformTemplateAsset"
      ADD CONSTRAINT "PlatformTemplateAsset_page_count_check" CHECK ("page_count" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PlatformTemplateAsset_sha256_check') THEN
    ALTER TABLE "documents"."PlatformTemplateAsset"
      ADD CONSTRAINT "PlatformTemplateAsset_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PlatformTemplateAsset_storage_key_check') THEN
    ALTER TABLE "documents"."PlatformTemplateAsset"
      ADD CONSTRAINT "PlatformTemplateAsset_storage_key_check" CHECK ("storage_key" LIKE 'documents/platform/%');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'documents' AND indexname = 'PlatformTemplateAsset_template_version_id_idx') THEN
    CREATE INDEX "PlatformTemplateAsset_template_version_id_idx" ON "documents"."PlatformTemplateAsset" ("template_version_id");
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION documents.enforce_platform_template_asset()
RETURNS TRIGGER AS $$
DECLARE
  v_tenant UUID;
  v_status TEXT;
  v_found  BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'PlatformTemplateAsset rows are written once (TEMPLATE-PRODUCT-1 7.1)'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT v."tenant_id", v."status", true INTO v_tenant, v_status, v_found
    FROM "documents"."TemplateVersion" v WHERE v."id" = NEW."template_version_id";
  IF v_found IS NOT TRUE OR v_tenant IS NOT NULL OR v_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'PlatformTemplateAsset needs a DRAFT PLATFORM template version (TEMPLATE-PRODUCT-1 7.1)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS platform_template_asset_guard ON "documents"."PlatformTemplateAsset";
CREATE TRIGGER platform_template_asset_guard
  BEFORE INSERT OR UPDATE ON "documents"."PlatformTemplateAsset"
  FOR EACH ROW EXECUTE FUNCTION documents.enforce_platform_template_asset();
