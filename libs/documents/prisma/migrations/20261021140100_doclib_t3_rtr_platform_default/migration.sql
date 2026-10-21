-- Aramo-DOC-TEMPLATE-LIB-1 (Shared Document Template Library) v1.0 LOCKED — increment T-3, §5.
-- Governing ADR: Aramo-ADR-0034-Shared-Document-Template-Library-v1_0-LOCKED (F-1).
-- Conforming amendment row 6 (RTR-TEMPLATE-1 :171/:175-176/:191/:195-196 superseded).
--
-- ONE guarded data migration, in one DO block (one statement, so it is atomic under any
-- runner: psql, prisma migrate, or a multi-statement pg query):
--
--   (a) FAIL CLOSED, listing ids, when
--         - the platform sentinel tenant holds more than one RTR template, or
--         - a Document or DocumentRevision of any OTHER tenant references a version of the
--           sentinel RTR template, or
--         - the sentinel tenant exists but holds no RTR template while no Aramo (PLATFORM)
--           RTR default exists either, or
--         - a sentinel RTR template AND a PLATFORM RTR default both exist, or
--         - a tenant with no tenant-wide RTR selection holds more than one ACTIVE
--           tenant-wide RTR template (its choice would be a guess).
--   (b) CONVERT the sentinel RTR template + all its versions to the Aramo default:
--       owner_scope = PLATFORM, tenant_id = NULL (template and versions). Content, ids,
--       version numbers and statuses are untouched. A NULL current_version_id (left by
--       the backfill, see below) is pinned to the template's single ACTIVE version. Sentinel TemplateAsset rows (none in
--       production) are left in place and are not referenced by PLATFORM content.
--   (c) BACKFILL the explicit selection: every tenant with exactly one ACTIVE tenant-wide
--       (client_id NULL) TENANT RTR template gets TenantTemplateSelection(tenant, RTR,
--       NULL, that template), selected_by the system actor. Behaviour is unchanged for
--       those tenants. Client-scoped templates were never resolved before and get no
--       selection here.
--
-- ONE-TIME GOVERNED CONVERSION (S-1 break-glass precedent). The T-1 immutability trigger
-- template_version_immutability freezes TemplateVersion.tenant_id on every UPDATE, so (b)
-- disables EXACTLY that trigger for the single guarded UPDATE of the sentinel template's
-- versions and re-enables it immediately, inside this same transaction, and the
-- post-conditions assert both TemplateVersion triggers are enabled again before COMMIT.
-- template_version_tenant_matches_template is NOT disabled: the parent template is
-- converted first, so each version's new NULL tenant_id equals its parent's. There is
-- deliberately NO GUC / session bypass in the trigger code — a later conversion needs its
-- own governed migration.
--
-- Fresh environments: identity migrations run before this one but the sentinel Tenant
-- row is created later by the identity seed, so the RTR-TEMPLATE-1 backfill
-- (20261004120000) found no sentinel to seed. When the sentinel Tenant row does NOT exist
-- and no PLATFORM RTR default exists, the Aramo RTR default is created here with the same
-- name and content (field_schema byte-identical to DEFAULT_RTR_TEMPLATE_CONTENT_V1, the
-- parity spec asserts it), so every environment ends with exactly one Aramo RTR default.
--
-- Skipped (NOTICE) in a documents-only container ("identity"."Tenant" absent, the
-- 20261004120000 precedent) and when the RTR DocumentType is not seeded.
-- Idempotent: a re-run finds no sentinel template and an existing PLATFORM default, and
-- the selection insert is ON CONFLICT DO NOTHING.
-- splitDdl-safe: no semicolons in comment lines.

DO $$
DECLARE
  c_sentinel CONSTANT UUID := '01900000-0000-7000-8000-000000000100';
  c_rtr CONSTANT UUID := 'd0c50005-0000-7000-8000-000000000001';
  c_system CONSTANT UUID := '00000000-0000-0000-0000-000000000000';
  v_sentinel_tenant_exists BOOLEAN := false;
  v_sentinel_count INT;
  v_sentinel_ids TEXT;
  v_platform_count INT;
  v_platform_ids TEXT;
  v_tpl UUID;
  v_client UUID;
  v_current UUID;
  v_active_count INT;
  v_active UUID;
  v_refs TEXT;
  v_ambiguous TEXT;
  v_enabled "char";
  v_trigger TEXT;
  v_bad INT;
  v_new_tpl UUID;
  v_new_ver UUID;
BEGIN
  IF to_regclass('"identity"."Tenant"') IS NULL THEN
    RAISE NOTICE 'DOC-TEMPLATE-LIB-1 T-3 RTR conversion skipped: "identity"."Tenant" absent (documents-only container).';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "documents"."DocumentType" WHERE "id" = c_rtr) THEN
    RAISE NOTICE 'DOC-TEMPLATE-LIB-1 T-3 RTR conversion skipped: the RIGHT_TO_REPRESENT DocumentType is not seeded.';
    RETURN;
  END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM "identity"."Tenant" WHERE "id" = $1)'
    INTO v_sentinel_tenant_exists USING c_sentinel;

  -- No concurrent template / selection writes while the guards and the conversion run.
  LOCK TABLE "documents"."DocumentTemplate", "documents"."TemplateVersion", "documents"."TenantTemplateSelection"
    IN SHARE ROW EXCLUSIVE MODE;

  SELECT count(*), string_agg("id"::text, ', ' ORDER BY "id")
    INTO v_sentinel_count, v_sentinel_ids
    FROM "documents"."DocumentTemplate"
   WHERE "tenant_id" = c_sentinel AND "document_type_id" = c_rtr;
  SELECT count(*), string_agg("id"::text, ', ' ORDER BY "id")
    INTO v_platform_count, v_platform_ids
    FROM "documents"."DocumentTemplate"
   WHERE "owner_scope" = 'PLATFORM' AND "document_type_id" = c_rtr;

  -- ── (a) + (b) — the sentinel RTR template becomes the Aramo RTR default ─────
  IF v_sentinel_count > 1 THEN
    RAISE EXCEPTION 'DOC-TEMPLATE-LIB-1 T-3: the platform sentinel tenant holds % RTR templates (exactly one expected) - ids: %',
      v_sentinel_count, v_sentinel_ids;
  END IF;

  IF v_sentinel_count = 1 THEN
    IF v_platform_count > 0 THEN
      RAISE EXCEPTION 'DOC-TEMPLATE-LIB-1 T-3: a sentinel RTR template (%) and a PLATFORM RTR default (%) both exist',
        v_sentinel_ids, v_platform_ids;
    END IF;
    SELECT "id", "client_id", "current_version_id" INTO v_tpl, v_client, v_current
      FROM "documents"."DocumentTemplate"
     WHERE "tenant_id" = c_sentinel AND "document_type_id" = c_rtr;
    IF v_client IS NOT NULL THEN
      RAISE EXCEPTION 'DOC-TEMPLATE-LIB-1 T-3: the sentinel RTR template % is client-scoped (client %) and cannot become an Aramo default',
        v_tpl, v_client;
    END IF;

    SELECT string_agg(x, ', ' ORDER BY x) INTO v_refs FROM (
      SELECT 'Document ' || d."id" || ' (tenant ' || d."tenant_id" || ')' AS x
        FROM "documents"."Document" d
        JOIN "documents"."TemplateVersion" v ON v."id" = d."template_version_id"
       WHERE v."template_id" = v_tpl AND d."tenant_id" <> c_sentinel
      UNION ALL
      SELECT 'DocumentRevision ' || r."id" || ' (tenant ' || r."tenant_id" || ')' AS x
        FROM "documents"."DocumentRevision" r
        JOIN "documents"."TemplateVersion" v ON v."id" = r."template_version_id"
       WHERE v."template_id" = v_tpl AND r."tenant_id" <> c_sentinel
    ) refs;
    IF v_refs IS NOT NULL THEN
      RAISE EXCEPTION 'DOC-TEMPLATE-LIB-1 T-3: other tenants reference the sentinel RTR template % versions - refusing to convert: %',
        v_tpl, v_refs;
    END IF;

    -- The RTR-TEMPLATE-1 backfill's final UPDATE (current_version_id := the inserted
    -- version) runs in the same statement as its data-modifying CTEs, so it cannot see the
    -- rows those CTEs inserted and pinned nothing: backfilled templates carry
    -- current_version_id NULL until an admin activates a version. The Aramo default must be
    -- resolvable, so the conversion pins it to its ONE ACTIVE version (the pin the backfill
    -- intended), failing closed when there is not exactly one.
    IF v_current IS NULL THEN
      SELECT count(*), max("id"::text)::uuid INTO v_active_count, v_active
        FROM "documents"."TemplateVersion" WHERE "template_id" = v_tpl AND "status" = 'ACTIVE';
      IF v_active_count <> 1 THEN
        RAISE EXCEPTION 'DOC-TEMPLATE-LIB-1 T-3: the sentinel RTR template % has no current version and % ACTIVE versions (exactly one expected)',
          v_tpl, v_active_count;
      END IF;
    END IF;

    -- Parent first (the owner CHECKs hold on this single-row UPDATE).
    UPDATE "documents"."DocumentTemplate"
       SET "owner_scope" = 'PLATFORM', "tenant_id" = NULL,
           "current_version_id" = COALESCE("current_version_id", v_active), "updated_at" = now()
     WHERE "id" = v_tpl;

    -- One-time governed conversion of the versions' tenant_id (see header).
    ALTER TABLE "documents"."TemplateVersion" DISABLE TRIGGER template_version_immutability;
    UPDATE "documents"."TemplateVersion" SET "tenant_id" = NULL WHERE "template_id" = v_tpl;
    ALTER TABLE "documents"."TemplateVersion" ENABLE TRIGGER template_version_immutability;

    RAISE NOTICE 'DOC-TEMPLATE-LIB-1 T-3: sentinel RTR template % converted to the Aramo (PLATFORM) RTR default.', v_tpl;
  ELSIF v_platform_count = 0 THEN
    IF v_sentinel_tenant_exists THEN
      RAISE EXCEPTION 'DOC-TEMPLATE-LIB-1 T-3: the platform sentinel tenant exists but holds no RTR template, and no PLATFORM RTR default exists';
    END IF;
    -- Fresh environment (no sentinel Tenant row yet): create the Aramo RTR default.
    v_new_tpl := gen_random_uuid();
    v_new_ver := gen_random_uuid();
    INSERT INTO "documents"."DocumentTemplate"
      ("id", "owner_scope", "tenant_id", "document_type_id", "client_id", "name", "description",
       "template_kind", "status", "current_version_id", "created_by")
    VALUES
      (v_new_tpl, 'PLATFORM', NULL, c_rtr, NULL, 'Standard Right to Represent',
       'Aramo default Right to Represent template (DOC-TEMPLATE-LIB-1 T-3).',
       'GENERATED', 'ACTIVE', NULL, c_system);
    INSERT INTO "documents"."TemplateVersion"
      ("id", "tenant_id", "template_id", "version_number", "status", "render_schema_version", "field_schema",
       "created_by", "activated_at")
    VALUES
      (v_new_ver, NULL, v_new_tpl, 1, 'ACTIVE', 'rtr-generated-v1',
       '{"render_schema_version":"rtr-generated-v1","title":"Right to Represent","blocks":[{"type":"HEADING","text":"Right to Represent"},{"type":"TEXT","text":"This authorizes representation of {{talent.full_name}} to the associated client for the associated requisition."}]}'::jsonb,
       c_system, now());
    UPDATE "documents"."DocumentTemplate"
       SET "current_version_id" = v_new_ver, "updated_at" = now()
     WHERE "id" = v_new_tpl;
    RAISE NOTICE 'DOC-TEMPLATE-LIB-1 T-3: no sentinel tenant yet - Aramo (PLATFORM) RTR default % created.', v_new_tpl;
  ELSE
    RAISE NOTICE 'DOC-TEMPLATE-LIB-1 T-3: the Aramo RTR default already exists (%) - conversion already applied.', v_platform_ids;
  END IF;

  -- ── Post-conditions (before COMMIT) ─────────────────────────────────────────
  FOREACH v_trigger IN ARRAY ARRAY['template_version_immutability', 'template_version_tenant_matches_template'] LOOP
    SELECT t."tgenabled" INTO v_enabled
      FROM pg_trigger t
     WHERE t."tgrelid" = '"documents"."TemplateVersion"'::regclass AND t."tgname" = v_trigger;
    IF v_enabled IS DISTINCT FROM 'O' THEN
      RAISE EXCEPTION 'DOC-TEMPLATE-LIB-1 T-3 post-condition: trigger % on TemplateVersion is not enabled (tgenabled=%)', v_trigger, v_enabled;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_bad FROM "documents"."DocumentTemplate"
   WHERE ("owner_scope" = 'PLATFORM') <> ("tenant_id" IS NULL)
      OR ("owner_scope" = 'PLATFORM' AND "client_id" IS NOT NULL);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'DOC-TEMPLATE-LIB-1 T-3 post-condition: % DocumentTemplate rows violate the owner CHECKs', v_bad;
  END IF;
  SELECT count(*) INTO v_bad FROM "documents"."TemplateVersion" v
    JOIN "documents"."DocumentTemplate" t ON t."id" = v."template_id"
   WHERE v."tenant_id" IS DISTINCT FROM t."tenant_id";
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'DOC-TEMPLATE-LIB-1 T-3 post-condition: % TemplateVersion rows differ from their template tenant', v_bad;
  END IF;
  SELECT count(*) INTO v_bad FROM "documents"."DocumentTemplate"
   WHERE "owner_scope" = 'PLATFORM' AND "document_type_id" = c_rtr;
  IF v_bad < 1 THEN
    RAISE EXCEPTION 'DOC-TEMPLATE-LIB-1 T-3 post-condition: no PLATFORM RTR default exists';
  END IF;
  SELECT count(*) INTO v_bad FROM "documents"."DocumentTemplate" t
   WHERE t."owner_scope" = 'PLATFORM' AND t."document_type_id" = c_rtr AND t."status" = 'ACTIVE'
     AND NOT EXISTS (
       SELECT 1 FROM "documents"."TemplateVersion" v
        WHERE v."id" = t."current_version_id" AND v."template_id" = t."id" AND v."status" = 'ACTIVE');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'DOC-TEMPLATE-LIB-1 T-3 post-condition: % ACTIVE PLATFORM RTR defaults do not pin an ACTIVE current version', v_bad;
  END IF;
  IF EXISTS (SELECT 1 FROM "documents"."DocumentTemplate" WHERE "tenant_id" = c_sentinel AND "document_type_id" = c_rtr) THEN
    RAISE EXCEPTION 'DOC-TEMPLATE-LIB-1 T-3 post-condition: the sentinel tenant still holds an RTR template';
  END IF;

  -- ── (c) — explicit selection for every tenant's existing RTR template ────────
  SELECT string_agg(a.x, ', ' ORDER BY a.x) INTO v_ambiguous FROM (
    SELECT 'tenant ' || t."tenant_id" || ' templates [' || string_agg(t."id"::text, ', ' ORDER BY t."id") || ']' AS x
      FROM "documents"."DocumentTemplate" t
     WHERE t."owner_scope" = 'TENANT' AND t."document_type_id" = c_rtr AND t."client_id" IS NULL AND t."status" = 'ACTIVE'
       AND NOT EXISTS (
         SELECT 1 FROM "documents"."TenantTemplateSelection" s
          WHERE s."tenant_id" = t."tenant_id" AND s."document_type_id" = c_rtr AND s."client_id" IS NULL)
     GROUP BY t."tenant_id"
    HAVING count(*) > 1
  ) a;
  IF v_ambiguous IS NOT NULL THEN
    RAISE EXCEPTION 'DOC-TEMPLATE-LIB-1 T-3: tenants hold more than one ACTIVE tenant-wide RTR template - choose explicitly first: %',
      v_ambiguous;
  END IF;

  INSERT INTO "documents"."TenantTemplateSelection"
    ("id", "tenant_id", "document_type_id", "client_id", "template_id", "selected_by", "selected_at", "created_at", "updated_at")
  SELECT gen_random_uuid(), t."tenant_id", c_rtr, NULL, t."id", c_system, now(), now(), now()
    FROM "documents"."DocumentTemplate" t
   WHERE t."owner_scope" = 'TENANT' AND t."document_type_id" = c_rtr AND t."client_id" IS NULL AND t."status" = 'ACTIVE'
     AND (SELECT count(*) FROM "documents"."DocumentTemplate" o
           WHERE o."owner_scope" = 'TENANT' AND o."tenant_id" = t."tenant_id" AND o."document_type_id" = c_rtr
             AND o."client_id" IS NULL AND o."status" = 'ACTIVE') = 1
  ON CONFLICT ("tenant_id", "document_type_id", "client_id") DO NOTHING;
END $$;
