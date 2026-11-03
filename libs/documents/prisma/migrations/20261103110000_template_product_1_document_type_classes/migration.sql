-- Aramo-TEMPLATE-PRODUCT-1 (Document Types, Product Tags, Fixed Forms and Personal Studio)
-- Implementation Directive v1.0 LOCKED — increment TP-3, §4.1.
--
-- ADD (never rename) four columns to documents.DocumentType so Platform Admin can manage
-- document types:
--   type_class     TEXT NOT NULL, TEMPLATE or UPLOAD. UPLOAD = an upload slot, never a
--                  template. Default TEMPLATE (a tenant-created type stays TEMPLATE with no
--                  kind, so it is not usable for templates — behaviour unchanged).
--   template_kind  TEXT NULL, EDITABLE or FIXED_FORM. NULL = not yet configured.
--   products       TEXT[] NOT NULL DEFAULT empty. Template product keys (ats, sign).
--   category       TEXT NULL. Gallery grouping.
-- An UPLOAD row never carries a kind or products (CHECK).
--
-- Backfill (exactly §4.1): the 6 TALENT_* SYSTEM rows become UPLOAD, every other row stays
-- TEMPLATE. RIGHT_TO_REPRESENT becomes EDITABLE, products ats + sign, category Recruiting
-- (only where still unconfigured, so a re-run never overwrites a later edit). Every other
-- row keeps kind NULL, products empty, category NULL.
--
-- One partial UNIQUE index on key for SYSTEM rows (tenant_id NULL): the existing
-- (tenant_id, key) unique index does not enforce for NULL tenant_id, and Platform Admin now
-- creates SYSTEM types with a key derived from the name. FAIL CLOSED, listing the keys,
-- when duplicate SYSTEM keys already exist.
--
-- One DO block (atomic). Idempotent: every step checks the catalog first.
-- splitDdl-safe: no semicolons in comment lines.

DO $$
DECLARE
  c_rtr CONSTANT UUID := 'd0c50005-0000-7000-8000-000000000001';
  v_dup TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'documents' AND table_name = 'DocumentType' AND column_name = 'type_class') THEN
    ALTER TABLE "documents"."DocumentType" ADD COLUMN "type_class" TEXT NOT NULL DEFAULT 'TEMPLATE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'documents' AND table_name = 'DocumentType' AND column_name = 'template_kind') THEN
    ALTER TABLE "documents"."DocumentType" ADD COLUMN "template_kind" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'documents' AND table_name = 'DocumentType' AND column_name = 'products') THEN
    ALTER TABLE "documents"."DocumentType" ADD COLUMN "products" TEXT[] NOT NULL DEFAULT '{}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'documents' AND table_name = 'DocumentType' AND column_name = 'category') THEN
    ALTER TABLE "documents"."DocumentType" ADD COLUMN "category" TEXT;
  END IF;

  -- Backfill BEFORE the UPLOAD constraint (the TALENT_* rows have no kind or products).
  UPDATE "documents"."DocumentType"
     SET "type_class" = 'UPLOAD'
   WHERE "tenant_id" IS NULL
     AND "key" IN ('TALENT_RESUME', 'TALENT_COVER_LETTER', 'TALENT_CERTIFICATION', 'TALENT_WORK_SAMPLE', 'TALENT_REFERENCE_LETTER', 'TALENT_OTHER')
     AND "type_class" <> 'UPLOAD';
  UPDATE "documents"."DocumentType"
     SET "template_kind" = 'EDITABLE', "products" = ARRAY['ats', 'sign'], "category" = 'Recruiting'
   WHERE "id" = c_rtr AND "template_kind" IS NULL AND "products" = '{}' AND "category" IS NULL;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DocumentType_type_class_check') THEN
    ALTER TABLE "documents"."DocumentType"
      ADD CONSTRAINT "DocumentType_type_class_check" CHECK ("type_class" IN ('TEMPLATE', 'UPLOAD'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DocumentType_template_kind_check') THEN
    ALTER TABLE "documents"."DocumentType"
      ADD CONSTRAINT "DocumentType_template_kind_check" CHECK ("template_kind" IS NULL OR "template_kind" IN ('EDITABLE', 'FIXED_FORM'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DocumentType_products_check') THEN
    ALTER TABLE "documents"."DocumentType"
      ADD CONSTRAINT "DocumentType_products_check" CHECK ("products" <@ ARRAY['ats', 'sign']::TEXT[]);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DocumentType_upload_not_template_check') THEN
    ALTER TABLE "documents"."DocumentType"
      ADD CONSTRAINT "DocumentType_upload_not_template_check"
      CHECK ("type_class" = 'TEMPLATE' OR ("template_kind" IS NULL AND "products" = '{}'));
  END IF;

  IF to_regclass('"documents"."DocumentType_system_key_key"') IS NULL THEN
    SELECT string_agg(k."key", ', ' ORDER BY k."key") INTO v_dup
      FROM (SELECT "key" FROM "documents"."DocumentType" WHERE "tenant_id" IS NULL GROUP BY "key" HAVING count(*) > 1) k;
    IF v_dup IS NOT NULL THEN
      RAISE EXCEPTION 'TEMPLATE-PRODUCT-1 TP-3: duplicate SYSTEM DocumentType keys: %', v_dup;
    END IF;
    CREATE UNIQUE INDEX "DocumentType_system_key_key" ON "documents"."DocumentType" ("key") WHERE "tenant_id" IS NULL;
  END IF;
END $$;
