-- Aramo-TEMPLATE-PRODUCT-1 (Document Types, Product Tags, Fixed Forms and Personal Studio)
-- Implementation Directive v1.0 LOCKED — increment TP-5, §6.1 and §6.2.
--
-- Tag inheritance. The CHECK DocumentTemplate_products_platform_only_check (DOC-TEMPLATE-LIB-1
-- T-1: a TENANT row carries no products) is REPLACED by:
--   DocumentTemplate_products_platform_not_null_check  a PLATFORM row carries non-null
--                                                      products. A TENANT row may carry them.
-- A TENANT row's products are written only by the server: copied from the source default at
-- Adopt, or from the document type when a tenant template is created any other way. No tenant
-- route accepts products. The BEFORE INSERT trigger document_template_products_from_type is
-- the backstop of the second rule: a row inserted with NULL products takes its document
-- type's products (it never overrides products the server set, e.g. at Adopt).
-- adopted_from_* stays provenance only: tags are copied, never read through the link.
--
-- Backfill (exactly §6.2):
--   the platform RIGHT_TO_REPRESENT default(s) get products ats + sign where still empty
--   every other PLATFORM row with NULL products gets an empty array (the new CHECK)
--   every existing TENANT template gets its document type's products (before this migration
--     a TENANT row could only hold NULL, so "products IS NULL" is every existing row, and a
--     re-run never overwrites tags written since). Astre's RTR template gets ats + sign, so
--     nothing it uses today disappears.
--
-- Fails closed when a PLATFORM row would still have NULL products. One DO block (atomic) after
-- the trigger function. Idempotent: the function is CREATE OR REPLACE, every other step
-- checks the catalog first, and the backfill writes only rows still without products.
-- splitDdl-safe: no semicolons in comment lines.

CREATE OR REPLACE FUNCTION documents.document_template_products_from_type()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."products" IS NULL THEN
    SELECT dt."products" INTO NEW."products"
      FROM "documents"."DocumentType" dt WHERE dt."id" = NEW."document_type_id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  c_rtr CONSTANT UUID := 'd0c50005-0000-7000-8000-000000000001';
  v_bad TEXT;
BEGIN
  UPDATE "documents"."DocumentTemplate"
     SET "products" = ARRAY['ats', 'sign']
   WHERE "owner_scope" = 'PLATFORM' AND "document_type_id" = c_rtr
     AND ("products" IS NULL OR "products" = '{}');
  UPDATE "documents"."DocumentTemplate"
     SET "products" = '{}'
   WHERE "owner_scope" = 'PLATFORM' AND "products" IS NULL;

  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DocumentTemplate_products_platform_only_check') THEN
    ALTER TABLE "documents"."DocumentTemplate" DROP CONSTRAINT "DocumentTemplate_products_platform_only_check";
  END IF;

  UPDATE "documents"."DocumentTemplate" t
     SET "products" = dt."products"
    FROM "documents"."DocumentType" dt
   WHERE t."owner_scope" = 'TENANT' AND dt."id" = t."document_type_id"
     AND t."products" IS NULL;

  SELECT string_agg(t."id"::text, ', ' ORDER BY t."id") INTO v_bad
    FROM "documents"."DocumentTemplate" t WHERE t."owner_scope" = 'PLATFORM' AND t."products" IS NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'TEMPLATE-PRODUCT-1 TP-5: PLATFORM templates without products: %', v_bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DocumentTemplate_products_platform_not_null_check') THEN
    ALTER TABLE "documents"."DocumentTemplate"
      ADD CONSTRAINT "DocumentTemplate_products_platform_not_null_check"
      CHECK ("owner_scope" <> 'PLATFORM' OR "products" IS NOT NULL);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'document_template_products_from_type'
                   AND tgrelid = '"documents"."DocumentTemplate"'::regclass) THEN
    CREATE TRIGGER document_template_products_from_type
      BEFORE INSERT ON "documents"."DocumentTemplate"
      FOR EACH ROW EXECUTE FUNCTION documents.document_template_products_from_type();
  END IF;
END $$;
