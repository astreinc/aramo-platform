import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PrismaService,
  TemplateNotFoundError,
  TemplateResolutionService,
  TemplateSelectionInvalidError,
  TemplatesRepository,
} from '../index.js';

// DOC-TEMPLATE-LIB-1 T-3 (§4.2) — the generic TemplateResolutionService + the selection
// repository on real Postgres 17. Skipped unless ARAMO_RUN_INTEGRATION=1. Applies the
// documents module's own migrations (documents-only container: the T-3 RTR conversion
// is a NOTICE no-op here, so the only Aramo defaults are the ones each test inserts, under
// a fresh DocumentType per test).

const ROOT = resolve(__dirname, '../../../..');

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'DOC-TEMPLATE-LIB-1 T-3 — template resolution + selection — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let templates: TemplatesRepository;
    let resolution: TemplateResolutionService;
    const ACTOR = randomUUID();

    async function newDocumentType(): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class)
         VALUES ($1, NULL, $2, 'Doc', 'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD')`,
        [id, `T3_TYPE_${id.slice(0, 8)}`],
      );
      return id;
    }

    // An Aramo (PLATFORM) default with ONE ACTIVE version (raw: PLATFORM authoring is T-2).
    async function platformDefault(
      typeId: string,
      opts?: { withdrawEffective?: Date; status?: string },
    ): Promise<{ templateId: string; versionId: string }> {
      const templateId = randomUUID();
      const versionId = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentTemplate"
           (id, owner_scope, tenant_id, document_type_id, name, template_kind, status, created_by, withdraw_notice_at, withdraw_effective_at)
         VALUES ($1,'PLATFORM',NULL,$2,'Aramo default','GENERATED',$3,$4,$5,$6)`,
        [
          templateId,
          typeId,
          opts?.status ?? 'ACTIVE',
          ACTOR,
          opts?.withdrawEffective !== undefined ? new Date(opts.withdrawEffective.getTime() - 7 * 86_400_000) : null,
          opts?.withdrawEffective ?? null,
        ],
      );
      await db.query(
        `INSERT INTO "documents"."TemplateVersion"
           (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by, activated_at)
         VALUES ($1,NULL,$2,1,'ACTIVE','v1','{"blocks":[]}'::jsonb,$3,now())`,
        [versionId, templateId, ACTOR],
      );
      await db.query(`UPDATE "documents"."DocumentTemplate" SET current_version_id = $1 WHERE id = $2`, [versionId, templateId]);
      return { templateId, versionId };
    }

    // A TENANT template approved through the repository (activateVersion also selects it).
    async function tenantTemplate(
      tenant: string,
      typeId: string,
      clientId?: string,
    ): Promise<{ templateId: string; versionId: string }> {
      const tpl = await templates.createTemplate({
        tenant_id: tenant,
        document_type_id: typeId,
        name: clientId === undefined ? 'Tenant wording' : 'Client wording',
        template_kind: 'GENERATED',
        created_by: ACTOR,
        ...(clientId !== undefined ? { client_id: clientId } : {}),
      });
      const ver = await templates.createVersion({
        tenant_id: tenant,
        template_id: tpl.id,
        render_schema_version: 'v1',
        field_schema: { blocks: [] },
        created_by: ACTOR,
      });
      await templates.activateVersion({ tenant_id: tenant, version_id: ver.id, actor_id: ACTOR, require_preview: false });
      return { templateId: tpl.id, versionId: ver.id };
    }

    // ORG-UX-1 §5.3 (T-A) — a GRANDFATHERED selection of an Aramo default, as the
    // 20261022130000 migration writes it (raw: the repository refuses new PLATFORM selections).
    async function legacySelect(tenant: string, typeId: string, clientId: string | null, templateId: string): Promise<void> {
      await db.query(
        `INSERT INTO "documents"."TenantTemplateSelection" (id, tenant_id, document_type_id, client_id, template_id, selected_by, updated_at, legacy_platform)
         VALUES ($1,$2,$3,$4,$5,$6,now(),true)`,
        [randomUUID(), tenant, typeId, clientId, templateId, ACTOR],
      );
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
      prisma = new PrismaService(url);
      await prisma.$connect();
      templates = new TemplatesRepository(prisma);
      resolution = new TemplateResolutionService(templates);
    }, 300_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    // ── Resolution order ──────────────────────────────────────────────────────
    // ORG-UX-1 §5.3 — gallery-first: nothing selected never resolves the Aramo default; a
    // grandfathered (legacy) selection does.
    it('client selection > tenant selection > (no fallback to the Aramo default), each pinning the exact current version', async () => {
      const type = await newDocumentType();
      const tenant = randomUUID();
      const client = randomUUID();
      const def = await platformDefault(type);

      // Nothing selected → SELECTION_REQUIRED (adopt or create, then approve).
      let r = await resolution.resolve({ tenant_id: tenant, document_type_id: type, client_id: client });
      expect(r).toEqual({ outcome: 'SELECTION_REQUIRED', withdrawn_template_ids: [] });

      // A grandfathered tenant-wide selection of the default → resolves it (T-A).
      await legacySelect(tenant, type, null, def.templateId);
      r = await resolution.resolve({ tenant_id: tenant, document_type_id: type, client_id: client });
      expect(r).toMatchObject({ outcome: 'RESOLVED', source: 'TENANT_SELECTION', owner_scope: 'PLATFORM' });
      if (r.outcome === 'RESOLVED') expect(r.version.id).toBe(def.versionId);

      // Tenant-wide own template (approval selects it) → wins over the default.
      const own = await tenantTemplate(tenant, type);
      r = await resolution.resolve({ tenant_id: tenant, document_type_id: type, client_id: client });
      expect(r).toMatchObject({ outcome: 'RESOLVED', source: 'TENANT_SELECTION', owner_scope: 'TENANT' });
      if (r.outcome === 'RESOLVED') expect(r.version.id).toBe(own.versionId);

      // Client-scoped template for THIS client → wins for this client only.
      const forClient = await tenantTemplate(tenant, type, client);
      r = await resolution.resolve({ tenant_id: tenant, document_type_id: type, client_id: client });
      expect(r).toMatchObject({ outcome: 'RESOLVED', source: 'CLIENT_SELECTION' });
      if (r.outcome === 'RESOLVED') expect(r.version.id).toBe(forClient.versionId);
      r = await resolution.resolve({ tenant_id: tenant, document_type_id: type, client_id: randomUUID() });
      if (r.outcome === 'RESOLVED') expect(r.version.id).toBe(own.versionId);
      r = await resolution.resolve({ tenant_id: tenant, document_type_id: type });
      if (r.outcome === 'RESOLVED') expect(r.version.id).toBe(own.versionId);

      // Another tenant (no grandfathered selection) must adopt first.
      r = await resolution.resolve({ tenant_id: randomUUID(), document_type_id: type, client_id: client });
      expect(r).toEqual({ outcome: 'SELECTION_REQUIRED', withdrawn_template_ids: [] });
    });

    it('a PLATFORM selection WITHOUT the legacy flag is ignored (only grandfathered selections may name a default)', async () => {
      const type = await newDocumentType();
      const tenant = randomUUID();
      const def = await platformDefault(type);
      await db.query(
        `INSERT INTO "documents"."TenantTemplateSelection" (id, tenant_id, document_type_id, client_id, template_id, selected_by, updated_at)
         VALUES ($1,$2,$3,NULL,$4,$5,now())`,
        [randomUUID(), tenant, type, def.templateId, ACTOR],
      );
      expect(await resolution.resolve({ tenant_id: tenant, document_type_id: type })).toEqual({
        outcome: 'SELECTION_REQUIRED',
        withdrawn_template_ids: [],
      });
    });

    it('a grandfathered selection may point a client at the Aramo default while the tenant-wide choice is the own template', async () => {
      const type = await newDocumentType();
      const tenant = randomUUID();
      const client = randomUUID();
      const def = await platformDefault(type);
      const own = await tenantTemplate(tenant, type);
      await legacySelect(tenant, type, client, def.templateId);
      const forClient = await resolution.resolve({ tenant_id: tenant, document_type_id: type, client_id: client });
      expect(forClient).toMatchObject({ outcome: 'RESOLVED', source: 'CLIENT_SELECTION', owner_scope: 'PLATFORM' });
      const tenantWide = await resolution.resolve({ tenant_id: tenant, document_type_id: type });
      if (tenantWide.outcome === 'RESOLVED') expect(tenantWide.version.id).toBe(own.versionId);
    });

    it('pins current_version_id: a newer ACTIVE version of the Aramo default moves the pin', async () => {
      const type = await newDocumentType();
      const def = await platformDefault(type);
      const v2 = randomUUID();
      await db.query(
        `INSERT INTO "documents"."TemplateVersion"
           (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by, activated_at)
         VALUES ($1,NULL,$2,2,'ACTIVE','v1','{"blocks":[]}'::jsonb,$3,now())`,
        [v2, def.templateId, ACTOR],
      );
      await db.query(`UPDATE "documents"."TemplateVersion" SET status='RETIRED', retired_at=now() WHERE id=$1`, [def.versionId]);
      await db.query(`UPDATE "documents"."DocumentTemplate" SET current_version_id=$1 WHERE id=$2`, [v2, def.templateId]);
      const tenant = randomUUID();
      await legacySelect(tenant, type, null, def.templateId);
      const r = await resolution.resolve({ tenant_id: tenant, document_type_id: type });
      expect(r.outcome).toBe('RESOLVED');
      if (r.outcome === 'RESOLVED') {
        expect(r.version.id).toBe(v2);
        expect(r.version.version_number).toBe(2);
      }
    });

    // ── Withdrawal (D10) — resolver half; the publishing flow is T-6 ─────────────
    // T-6 (§9) — the tenant relied on the withdrawn default and has no own template:
    // SELECTION_REQUIRED (no longer NOT_CONFIGURED, which means "never configured").
    it('a withdrawn Aramo default (effective date passed) is skipped → SELECTION_REQUIRED when nothing else applies', async () => {
      const type = await newDocumentType();
      const gone = await platformDefault(type, { withdrawEffective: new Date(Date.now() - 60_000) });
      const tenant = randomUUID();
      expect(await resolution.resolve({ tenant_id: tenant, document_type_id: type })).toEqual({
        outcome: 'SELECTION_REQUIRED',
        withdrawn_template_ids: [gone.templateId],
      });
    });

    it('a withdrawal with a FUTURE effective date still resolves a grandfathered selection (notice period)', async () => {
      const type = await newDocumentType();
      const def = await platformDefault(type, { withdrawEffective: new Date(Date.now() + 86_400_000) });
      const tenant = randomUUID();
      await legacySelect(tenant, type, null, def.templateId);
      const r = await resolution.resolve({ tenant_id: tenant, document_type_id: type });
      expect(r.outcome).toBe('RESOLVED');
      if (r.outcome === 'RESOLVED') expect(r.template.id).toBe(def.templateId);
    });

    // T-6 (§9; D10) — a selection naming a withdrawn default falls to the tenant's own
    // approved template, NEVER to another (live) Aramo default (no silent wording swap).
    it('a selection naming a withdrawn Aramo default falls back to the tenant’s own approved template, not another default', async () => {
      const type = await newDocumentType();
      const tenant = randomUUID();
      const client = randomUUID();
      const forClient = await tenantTemplate(tenant, type, client); // client selection, then re-point it below
      // The selected default is being withdrawn (notice), a replacement default is live.
      const gone = await platformDefault(type, { withdrawEffective: new Date(Date.now() + 86_400_000) });
      await platformDefault(type);
      await db.query(`DELETE FROM "documents"."TenantTemplateSelection" WHERE tenant_id = $1 AND client_id = $2`, [tenant, client]);
      await legacySelect(tenant, type, client, gone.templateId);
      await db.query(
        `UPDATE "documents"."DocumentTemplate" SET withdraw_notice_at = now() - interval '8 days', withdraw_effective_at = now() - interval '1 day' WHERE id = $1`,
        [gone.templateId],
      );
      const r = await resolution.resolve({ tenant_id: tenant, document_type_id: type, client_id: client });
      expect(r).toMatchObject({ outcome: 'RESOLVED', source: 'WITHDRAWAL_FALLBACK', owner_scope: 'TENANT' });
      if (r.outcome === 'RESOLVED') expect(r.version.id).toBe(forClient.versionId);
    });

    // T-6: two defaults with NO withdrawal can no longer coexist (DB index) — ambiguity is
    // still possible when every live default of the type is in its notice window.
    it('never picks an Aramo default when two live defaults exist and nothing is selected (SELECTION_REQUIRED)', async () => {
      const type = await newDocumentType();
      await platformDefault(type, { withdrawEffective: new Date(Date.now() + 86_400_000) });
      await platformDefault(type, { withdrawEffective: new Date(Date.now() + 2 * 86_400_000) });
      const r = await resolution.resolve({ tenant_id: randomUUID(), document_type_id: type });
      expect(r).toEqual({ outcome: 'SELECTION_REQUIRED', withdrawn_template_ids: [] });
    });

    it('NOT_CONFIGURED when there is no selection and no Aramo default; INVALID for a broken selected template', async () => {
      const type = await newDocumentType();
      const tenant = randomUUID();
      expect(await resolution.resolve({ tenant_id: tenant, document_type_id: type })).toEqual({ outcome: 'NOT_CONFIGURED' });
      // A selected TENANT template with no current version (raw rows bypass the repository).
      const broken = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentTemplate" (id, tenant_id, document_type_id, name, template_kind, status, created_by)
         VALUES ($1,$2,$3,'Broken','GENERATED','ACTIVE',$4)`,
        [broken, tenant, type, ACTOR],
      );
      await db.query(
        `INSERT INTO "documents"."TenantTemplateSelection" (id, tenant_id, document_type_id, client_id, template_id, selected_by)
         VALUES ($1,$2,$3,NULL,$4,$5)`,
        [randomUUID(), tenant, type, broken, ACTOR],
      );
      expect(await resolution.resolve({ tenant_id: tenant, document_type_id: type })).toMatchObject({
        outcome: 'INVALID',
        template_id: broken,
        reason: 'current_version_id_null',
      });
    });

    // ── Selection repository ──────────────────────────────────────────────────
    it('upsert inserts, replaces in place (one row per tenant/type/client), lists, and deletes', async () => {
      const type = await newDocumentType();
      const tenant = randomUUID();
      const def = await platformDefault(type);
      const own = await tenantTemplate(tenant, type); // activation inserted the tenant-wide row
      let rows = await templates.listSelections(tenant, type);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.template_id).toBe(own.templateId);
      expect(rows[0]?.selected_by).toBe(ACTOR);

      const other = randomUUID();
      const second = await templates.createTemplate({ tenant_id: tenant, document_type_id: type, name: 'Second', template_kind: 'GENERATED', created_by: ACTOR });
      const secondV = await templates.createVersion({ tenant_id: tenant, template_id: second.id, render_schema_version: 'v1', field_schema: { blocks: [] }, created_by: ACTOR });
      await templates.activateVersion({ tenant_id: tenant, version_id: secondV.id, actor_id: ACTOR, require_preview: false });
      const replaced = await templates.upsertSelection({ tenant_id: tenant, document_type_id: type, client_id: null, template_id: own.templateId, selected_by: other });
      expect(replaced.template_id).toBe(own.templateId);
      rows = await templates.listSelections(tenant, type);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(replaced.id);
      expect(rows[0]?.selected_by).toBe(other);
      expect((await templates.findSelection(tenant, type, null))?.template_id).toBe(own.templateId);

      // ORG-UX-1 §5.3 — an Aramo default is never selected directly.
      await expect(
        templates.upsertSelection({ tenant_id: tenant, document_type_id: type, client_id: null, template_id: def.templateId, selected_by: other }),
      ).rejects.toMatchObject({ reason: 'platform_template_not_selectable' });

      expect(await templates.deleteSelection(tenant, type, null)).toBe(true);
      expect(await templates.deleteSelection(tenant, type, null)).toBe(false);
      expect(await templates.listSelections(tenant, type)).toHaveLength(0);
      // No tenant-wide row = no fallback to the Aramo default.
      const r = await resolution.resolve({ tenant_id: tenant, document_type_id: type });
      expect(r).toEqual({ outcome: 'SELECTION_REQUIRED', withdrawn_template_ids: [] });
    });

    it('choosing an own template over a grandfathered selection clears the legacy flag', async () => {
      const type = await newDocumentType();
      const tenant = randomUUID();
      const def = await platformDefault(type);
      await legacySelect(tenant, type, null, def.templateId);
      const own = await tenantTemplate(tenant, type); // approval re-points the tenant-wide row
      const row = await templates.findSelection(tenant, type, null);
      expect(row?.template_id).toBe(own.templateId);
      expect(row?.legacy_platform ?? null).toBeNull();
    });

    it('upsert refuses a template the tenant cannot use (typed errors before the DB trigger)', async () => {
      const type = await newDocumentType();
      const otherType = await newDocumentType();
      const tenant = randomUUID();
      const foreign = await tenantTemplate(randomUUID(), type);
      await expect(
        templates.upsertSelection({ tenant_id: tenant, document_type_id: type, client_id: null, template_id: foreign.templateId, selected_by: ACTOR }),
      ).rejects.toBeInstanceOf(TemplateNotFoundError);
      const wrongType = await tenantTemplate(tenant, otherType);
      await expect(
        templates.upsertSelection({ tenant_id: tenant, document_type_id: type, client_id: null, template_id: wrongType.templateId, selected_by: ACTOR }),
      ).rejects.toBeInstanceOf(TemplateNotFoundError);
      const draft = await templates.createTemplate({ tenant_id: tenant, document_type_id: type, name: 'Draft', template_kind: 'GENERATED', created_by: ACTOR });
      await expect(
        templates.upsertSelection({ tenant_id: tenant, document_type_id: type, client_id: null, template_id: draft.id, selected_by: ACTOR }),
      ).rejects.toMatchObject({ reason: 'template_not_active' });
      const withdrawn = await platformDefault(type, { withdrawEffective: new Date(Date.now() - 60_000) });
      await expect(
        templates.upsertSelection({ tenant_id: tenant, document_type_id: type, client_id: null, template_id: withdrawn.templateId, selected_by: ACTOR }),
      ).rejects.toMatchObject({ reason: 'platform_template_not_selectable' });
      const clientTpl = await tenantTemplate(tenant, type, randomUUID());
      await expect(
        templates.upsertSelection({ tenant_id: tenant, document_type_id: type, client_id: null, template_id: clientTpl.templateId, selected_by: ACTOR }),
      ).rejects.toBeInstanceOf(TemplateSelectionInvalidError);
    });

    it('approving a newer version of the selected template keeps the selection and moves the pin', async () => {
      const type = await newDocumentType();
      const tenant = randomUUID();
      const own = await tenantTemplate(tenant, type);
      const v2 = await templates.createVersion({ tenant_id: tenant, template_id: own.templateId, render_schema_version: 'v1', field_schema: { blocks: [] }, created_by: ACTOR });
      await templates.activateVersion({ tenant_id: tenant, version_id: v2.id, actor_id: ACTOR, require_preview: false });
      expect(await templates.listSelections(tenant, type)).toHaveLength(1);
      const r = await resolution.resolve({ tenant_id: tenant, document_type_id: type });
      if (r.outcome === 'RESOLVED') expect(r.version.id).toBe(v2.id);
      expect(r.outcome).toBe('RESOLVED');
    });
  },
);
