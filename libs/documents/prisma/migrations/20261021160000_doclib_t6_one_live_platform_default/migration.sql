-- Aramo-DOC-TEMPLATE-LIB-1 (Shared Document Template Library) v1.0 LOCKED — increment T-6, §9.
-- Governing ADR: Aramo-ADR-0034-Shared-Document-Template-Library-v1_0-LOCKED (D3, D10).
--
-- ONE LIVE ARAMO DEFAULT PER DOCUMENT TYPE (T-3 divergence 5, resolved as routine TD).
--
-- Rule: at most ONE PLATFORM template per document_type_id may be ACTIVE and NOT withdrawn.
-- "Withdrawn" means a withdrawal has been PUBLISHED (withdraw_effective_at set, whether the
-- effective date is still ahead in the notice window or already past). Consequences:
--   * a replacement Aramo default for a type can be published only AFTER the current one
--     has been withdrawn (notice set). During the notice window both are resolvable and
--     the resolver prefers the one with no withdrawal (TemplateResolutionService)
--   * cancelling a withdrawal is refused while a replacement default is live (the index
--     rejects it and the platform write path maps it to a typed 409 first)
-- DRAFT (never published) defaults are not constrained.
--
-- Fail closed: when existing data already holds more than one live default for a type the
-- migration refuses and lists the type and template ids (an operator withdraws one first).
-- Index only — no column and no returned-shape change.
-- splitDdl-safe: no semicolons in comment lines.

DO $$
DECLARE
  v_dupes TEXT;
BEGIN
  SELECT string_agg(format('%s:[%s]', d."document_type_id", d."ids"), ', ')
    INTO v_dupes
    FROM (
      SELECT "document_type_id", string_agg("id"::text, ',' ORDER BY "id") AS "ids"
        FROM "documents"."DocumentTemplate"
       WHERE "owner_scope" = 'PLATFORM' AND "status" = 'ACTIVE' AND "withdraw_effective_at" IS NULL
       GROUP BY "document_type_id"
      HAVING count(*) > 1
    ) d;
  IF v_dupes IS NOT NULL THEN
    RAISE EXCEPTION 'DOC-TEMPLATE-LIB-1 T-6: more than one live Aramo default per document type (withdraw all but one first): %', v_dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX "DocumentTemplate_one_live_platform_default"
  ON "documents"."DocumentTemplate" ("document_type_id")
  WHERE "owner_scope" = 'PLATFORM' AND "status" = 'ACTIVE' AND "withdraw_effective_at" IS NULL;
