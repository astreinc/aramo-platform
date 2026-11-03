-- Aramo-TEMPLATE-PRODUCT-1 (Document Types, Product Tags, Fixed Forms and Personal Studio)
-- Implementation Directive v1.0 LOCKED — increment TP-1, §2.4.
--
-- Product tags become the entitlement capability keys (ats, sign), displayed as ATS / Sign.
-- This ONE guarded data migration lowercases the values already stored in
-- DocumentTemplate.products and TemplateVariable.products (ATS to ats, SIGN to sign) and
-- removes duplicates the lowercasing creates, keeping the first position of each key.
--
-- FAIL CLOSED, listing the offending ids and values, when any stored value is not one of
-- the two keys after lowercasing. Nothing is rewritten in that case.
--
-- One DO block (one statement, atomic under any runner). NULL products (TENANT templates)
-- and empty arrays are left as they are. No column, constraint or returned shape changes.
-- Idempotent: a re-run finds every value already lowercase and rewrites no row.
-- splitDdl-safe: no semicolons in comment lines.

DO $$
DECLARE
  v_bad TEXT;
BEGIN
  SELECT string_agg(format('DocumentTemplate %s: %s', t."id", p.v), ', ' ORDER BY t."id", p.v) INTO v_bad
    FROM "documents"."DocumentTemplate" t
    CROSS JOIN LATERAL unnest(t."products") AS p(v)
   WHERE lower(p.v) NOT IN ('ats', 'sign');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'TEMPLATE-PRODUCT-1 TP-1: unknown DocumentTemplate product tags (allowed: ats, sign): %', v_bad;
  END IF;
  SELECT string_agg(format('TemplateVariable %s: %s', t."key", p.v), ', ' ORDER BY t."key", p.v) INTO v_bad
    FROM "documents"."TemplateVariable" t
    CROSS JOIN LATERAL unnest(t."products") AS p(v)
   WHERE lower(p.v) NOT IN ('ats', 'sign');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'TEMPLATE-PRODUCT-1 TP-1: unknown TemplateVariable product tags (allowed: ats, sign): %', v_bad;
  END IF;

  UPDATE "documents"."DocumentTemplate" t
     SET "products" = ARRAY(
           SELECT k.v FROM (
             SELECT lower(p.v) AS v, min(p.ord) AS ord
               FROM unnest(t."products") WITH ORDINALITY AS p(v, ord)
              GROUP BY lower(p.v)
           ) k ORDER BY k.ord)
   WHERE t."products" IS NOT NULL
     AND EXISTS (SELECT 1 FROM unnest(t."products") AS p(v) WHERE p.v <> lower(p.v));

  UPDATE "documents"."TemplateVariable" t
     SET "products" = ARRAY(
           SELECT k.v FROM (
             SELECT lower(p.v) AS v, min(p.ord) AS ord
               FROM unnest(t."products") WITH ORDINALITY AS p(v, ord)
              GROUP BY lower(p.v)
           ) k ORDER BY k.ord)
   WHERE EXISTS (SELECT 1 FROM unnest(t."products") AS p(v) WHERE p.v <> lower(p.v));
END $$;
