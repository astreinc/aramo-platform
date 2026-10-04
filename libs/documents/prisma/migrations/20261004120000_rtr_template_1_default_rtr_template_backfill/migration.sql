-- RTR-TEMPLATE-1 (§7, §28) — default tenant-wide Right-to-Represent template backfill.
--
-- Seeds ONE ACTIVE DocumentTemplate + ONE ACTIVE TemplateVersion (version 1,
-- rtr-generated-v1 content) per EXISTING active tenant AND for the platform
-- SENTINEL tenant. After this slice, RTR generation is template-driven with no
-- inline fallback (INV-12); every pre-existing tenant must therefore already hold
-- a resolvable template at cutover. New tenants are provisioned at creation time
-- by TenantDocumentTemplateProvisioningService, which COPIES the sentinel's active
-- template (the same platform-template-copy precedent as policy provisioning) —
-- so the sentinel MUST carry one, hence it is seeded here unconditionally.
--
-- The field_schema JSON is byte-identical to DEFAULT_RTR_TEMPLATE_CONTENT_V1
-- (apps/api/src/rtr/rtr-template-content.ts); a parity test asserts they never
-- drift. This reproduces the current inline RTR body verbatim (§28) — an
-- architecture migration, not a legal-copy rewrite.
--
-- Guard: the whole seed is skipped when "identity"."Tenant" is absent (a
-- documents-only test container), making it a safe no-op there. In a full
-- environment identity migrations run earlier (lower timestamp), so the table
-- exists. Idempotent via NOT EXISTS; the TemplateVersion immutability trigger is
-- BEFORE UPDATE only, so inserting status='ACTIVE' directly is legal.

DO $$
BEGIN
  IF to_regclass('"identity"."Tenant"') IS NULL THEN
    RAISE NOTICE 'RTR-TEMPLATE-1 backfill skipped: "identity"."Tenant" absent (documents-only container).';
    RETURN;
  END IF;

  EXECUTE $backfill$
    WITH targets AS (
      SELECT t."id" AS tenant_id
      FROM "identity"."Tenant" t
      WHERE (t."is_active" = true OR t."id" = '01900000-0000-7000-8000-000000000100')
        AND NOT EXISTS (
          SELECT 1 FROM "documents"."DocumentTemplate" d
          WHERE d."tenant_id" = t."id"
            AND d."document_type_id" = 'd0c50005-0000-7000-8000-000000000001'
            AND d."client_id" IS NULL
            AND d."status" = 'ACTIVE'
        )
    ),
    ins_tpl AS (
      INSERT INTO "documents"."DocumentTemplate"
        ("id","tenant_id","document_type_id","client_id","name","description","template_kind","status","current_version_id","created_by")
      SELECT
        gen_random_uuid(), targets.tenant_id, 'd0c50005-0000-7000-8000-000000000001', NULL,
        'Standard Right to Represent',
        'Default tenant Right to Represent template (RTR-TEMPLATE-1 bootstrap).',
        'GENERATED', 'ACTIVE', NULL, '00000000-0000-0000-0000-000000000000'
      FROM targets
      RETURNING "id" AS template_id, "tenant_id"
    ),
    ins_ver AS (
      INSERT INTO "documents"."TemplateVersion"
        ("id","tenant_id","template_id","version_number","status","render_schema_version","field_schema","created_by","activated_at")
      SELECT
        gen_random_uuid(), ins_tpl."tenant_id", ins_tpl.template_id, 1, 'ACTIVE', 'rtr-generated-v1',
        '{"render_schema_version":"rtr-generated-v1","title":"Right to Represent","blocks":[{"type":"HEADING","text":"Right to Represent"},{"type":"TEXT","text":"This authorizes representation of {{talent.full_name}} to the associated client for the associated requisition."}]}'::jsonb,
        '00000000-0000-0000-0000-000000000000', now()
      FROM ins_tpl
      RETURNING "id" AS version_id, "template_id"
    )
    UPDATE "documents"."DocumentTemplate" d
    SET "current_version_id" = ins_ver.version_id, "updated_at" = now()
    FROM ins_ver
    WHERE d."id" = ins_ver."template_id";
  $backfill$;
END $$;
