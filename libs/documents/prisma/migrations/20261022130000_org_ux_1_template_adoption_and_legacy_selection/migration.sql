-- Aramo-ORG-UX-1 Implementation Directive v1.0 (LOCKED) §5.1 (Lead Correction B) and §5.3
-- (P2 T-A). Conforming amendments rows 1-4 and 6 (ADR-0034, DOC-TEMPLATE-LIB-1).
--
-- (1) ADD-not-rename provenance on DocumentTemplate: adopted_from_template_id and
--     adopted_from_version_id (nullable UUID, NO foreign key, no cascade). Written once
--     when a tenant ADOPTS an Aramo default. Audit/provenance only: resolution, rendering
--     and every update path ignore them, so a later change to the Aramo default never
--     reaches the tenant's independent copy.
-- (2) ADD-not-rename TenantTemplateSelection.legacy_platform (nullable BOOLEAN). The
--     resolver honours a selection naming a PLATFORM template ONLY when it is true.
-- (3) T-A GRANDFATHER (one guarded DO block, atomic): every tenant that resolves to an
--     Aramo default today keeps resolving to it.
--       a. every existing selection that names a PLATFORM template is marked
--          legacy_platform = true (an explicit choice the tenant already made)
--       b. for every tenant (except the platform sentinel) and every document type with
--          exactly ONE resolvable Aramo default (ACTIVE, current version pinned, not past
--          withdraw_effective_at, the not-withdrawing one preferred during a notice window)
--          and NO tenant-wide selection, a tenant-wide selection of that default is
--          inserted with legacy_platform = true, selected_by the system actor.
--     A type with more than one eligible default resolved INVALID before and gets no
--     selection here (never a guess). New tenants created after this migration and new
--     document types get no fallback: they adopt (or create) and approve.
--     Existing Document / DocumentRevision rows are untouched (their pinned versions stay).
--
-- Skipped (NOTICE) in a documents-only container ("identity"."Tenant" absent, the
-- 20261021140100 precedent): (1) and (2) still apply.
-- Idempotent: the column adds are IF NOT EXISTS, (a) is a no-op on marked rows, and (b)
-- inserts ON CONFLICT DO NOTHING on the selection unique index.
-- splitDdl-safe: no semicolons in comment lines.

ALTER TABLE "documents"."DocumentTemplate" ADD COLUMN IF NOT EXISTS "adopted_from_template_id" UUID;
ALTER TABLE "documents"."DocumentTemplate" ADD COLUMN IF NOT EXISTS "adopted_from_version_id" UUID;
ALTER TABLE "documents"."TenantTemplateSelection" ADD COLUMN IF NOT EXISTS "legacy_platform" BOOLEAN;

DO $$
DECLARE
  c_sentinel CONSTANT UUID := '01900000-0000-7000-8000-000000000100';
  c_system CONSTANT UUID := '00000000-0000-0000-0000-000000000000';
  v_marked INT := 0;
  v_inserted INT := 0;
BEGIN
  IF to_regclass('"identity"."Tenant"') IS NULL THEN
    RAISE NOTICE 'ORG-UX-1 T-A grandfather skipped: "identity"."Tenant" absent (documents-only container).';
    RETURN;
  END IF;

  LOCK TABLE "documents"."DocumentTemplate", "documents"."TenantTemplateSelection" IN SHARE ROW EXCLUSIVE MODE;

  -- (a) existing PLATFORM selections become legacy (grandfathered) selections.
  UPDATE "documents"."TenantTemplateSelection" s
     SET "legacy_platform" = true, "updated_at" = now()
    FROM "documents"."DocumentTemplate" t
   WHERE t."id" = s."template_id" AND t."owner_scope" = 'PLATFORM'
     AND s."legacy_platform" IS DISTINCT FROM true;
  GET DIAGNOSTICS v_marked = ROW_COUNT;

  -- (b) tenants with no tenant-wide selection keep the single resolvable default.
  EXECUTE $q$
    WITH live AS (
      SELECT t."id", t."document_type_id", t."withdraw_effective_at"
        FROM "documents"."DocumentTemplate" t
       WHERE t."owner_scope" = 'PLATFORM' AND t."tenant_id" IS NULL AND t."status" = 'ACTIVE'
         AND t."current_version_id" IS NOT NULL
         AND (t."withdraw_effective_at" IS NULL OR t."withdraw_effective_at" > now())
    ), preferred AS (
      SELECT l.* FROM live l
       WHERE l."withdraw_effective_at" IS NULL
          OR NOT EXISTS (SELECT 1 FROM live o WHERE o."document_type_id" = l."document_type_id" AND o."withdraw_effective_at" IS NULL)
    ), single AS (
      SELECT p."document_type_id", min(p."id"::text)::uuid AS "template_id"
        FROM preferred p GROUP BY p."document_type_id" HAVING count(*) = 1
    )
    INSERT INTO "documents"."TenantTemplateSelection"
      ("id", "tenant_id", "document_type_id", "client_id", "template_id", "selected_by", "selected_at", "created_at", "updated_at", "legacy_platform")
    SELECT gen_random_uuid(), tn."id", sg."document_type_id", NULL, sg."template_id", $1, now(), now(), now(), true
      FROM "identity"."Tenant" tn
     CROSS JOIN single sg
     WHERE tn."id" <> $2
       AND NOT EXISTS (
         SELECT 1 FROM "documents"."TenantTemplateSelection" x
          WHERE x."tenant_id" = tn."id" AND x."document_type_id" = sg."document_type_id" AND x."client_id" IS NULL)
    ON CONFLICT DO NOTHING
  $q$ USING c_system, c_sentinel;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  RAISE NOTICE 'ORG-UX-1 T-A grandfather: % existing PLATFORM selections marked legacy, % legacy tenant-wide selections inserted.', v_marked, v_inserted;
END
$$;
