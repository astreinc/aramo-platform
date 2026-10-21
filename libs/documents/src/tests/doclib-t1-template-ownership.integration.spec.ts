import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TemplateDraftAlreadyExistsError } from '../lib/domain/errors.js';
import { PrismaService, TemplatesRepository } from '../index.js';

// DOC-TEMPLATE-LIB-1 T-1 (§3 database foundation, §4.1 read union, §4.4 owner-aware
// provenance) on real Postgres 17. Skipped unless ARAMO_RUN_INTEGRATION=1. Applies
// the documents module's own migrations only (self-contained schema).

const ROOT = resolve(__dirname, '../../../..');

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'DOC-TEMPLATE-LIB-1 T-1 — template ownership foundation — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let templates: TemplatesRepository;

    const TENANT = randomUUID();
    const OTHER_TENANT = randomUUID();
    const ACTOR = randomUUID();

    async function newDocumentType(): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class)
         VALUES ($1, NULL, $2, 'RTR', 'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD')`,
        [id, `T1_TYPE_${id.slice(0, 8)}`],
      );
      return id;
    }

    async function insertTemplate(args: {
      owner_scope?: 'PLATFORM' | 'TENANT';
      tenant_id: string | null;
      typeId: string;
      client_id?: string | null;
      products?: string[] | null;
      withdraw?: boolean;
    }): Promise<string> {
      const id = randomUUID();
      const cols = ['id', 'tenant_id', 'document_type_id', 'client_id', 'name', 'template_kind', 'status', 'created_by'];
      const vals: unknown[] = [id, args.tenant_id, args.typeId, args.client_id ?? null, 'Tpl', 'GENERATED', 'ACTIVE', ACTOR];
      if (args.owner_scope !== undefined) {
        cols.push('owner_scope');
        vals.push(args.owner_scope);
      }
      if (args.products !== undefined) {
        cols.push('products');
        vals.push(args.products);
      }
      if (args.withdraw === true) {
        cols.push('withdraw_notice_at', 'withdraw_effective_at');
        vals.push(new Date(), new Date(Date.now() + 7 * 86_400_000));
      }
      const ph = vals.map((_, i) => `$${i + 1}`).join(',');
      await db.query(
        `INSERT INTO "documents"."DocumentTemplate" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${ph})`,
        vals,
      );
      return id;
    }

    async function insertVersion(templateId: string, tenantId: string | null, n: number, status: string): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO "documents"."TemplateVersion"
           (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by)
         VALUES ($1,$2,$3,$4,$5,'v1','{"blocks":[]}'::jsonb,$6)`,
        [id, tenantId, templateId, n, status, ACTOR],
      );
      return id;
    }

    async function insertSelection(args: {
      tenant_id: string;
      typeId: string;
      client_id?: string | null;
      template_id: string;
    }): Promise<string> {
      const id = randomUUID();
      await db.query(
        `INSERT INTO "documents"."TenantTemplateSelection" (id, tenant_id, document_type_id, client_id, template_id, selected_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, args.tenant_id, args.typeId, args.client_id ?? null, args.template_id, ACTOR],
      );
      return id;
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
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    // ── §3.1 DocumentTemplate ownership CHECKs ─────────────────────────────────
    it('defaults existing-shape inserts to owner_scope TENANT (behaviour-neutral) with NULL products/withdraw', async () => {
      const typeId = await newDocumentType();
      const id = await insertTemplate({ tenant_id: TENANT, typeId });
      const r = await db.query(
        `SELECT owner_scope, products, withdraw_notice_at, withdraw_effective_at FROM "documents"."DocumentTemplate" WHERE id = $1`,
        [id],
      );
      expect(r.rows[0]).toEqual({ owner_scope: 'TENANT', products: null, withdraw_notice_at: null, withdraw_effective_at: null });
    });

    it('a PLATFORM row requires tenant_id NULL and a TENANT row requires tenant_id', async () => {
      const typeId = await newDocumentType();
      await expect(insertTemplate({ owner_scope: 'PLATFORM', tenant_id: TENANT, typeId })).rejects.toThrow(
        /DocumentTemplate_owner_tenant_check/,
      );
      await expect(insertTemplate({ owner_scope: 'TENANT', tenant_id: null, typeId })).rejects.toThrow(
        /DocumentTemplate_owner_tenant_check/,
      );
      await expect(insertTemplate({ tenant_id: null, typeId })).rejects.toThrow(/DocumentTemplate_owner_tenant_check/);
      await expect(insertTemplate({ owner_scope: 'PLATFORM', tenant_id: null, typeId })).resolves.toBeTypeOf('string');
    });

    it('rejects an unknown owner_scope', async () => {
      const typeId = await newDocumentType();
      await expect(
        db.query(
          `INSERT INTO "documents"."DocumentTemplate" (id, tenant_id, owner_scope, document_type_id, name, template_kind, status, created_by)
           VALUES ($1,$2,'CLIENT',$3,'x','GENERATED','DRAFT',$4)`,
          [randomUUID(), TENANT, typeId, ACTOR],
        ),
      ).rejects.toThrow(/DocumentTemplate_owner_scope_check/);
    });

    it('forbids client_id on a PLATFORM row (allowed on TENANT)', async () => {
      const typeId = await newDocumentType();
      await expect(
        insertTemplate({ owner_scope: 'PLATFORM', tenant_id: null, typeId, client_id: randomUUID() }),
      ).rejects.toThrow(/DocumentTemplate_platform_no_client_check/);
      await expect(insertTemplate({ tenant_id: TENANT, typeId, client_id: randomUUID() })).resolves.toBeTypeOf('string');
    });

    it('products and withdraw_* are PLATFORM-only', async () => {
      const typeId = await newDocumentType();
      await expect(insertTemplate({ tenant_id: TENANT, typeId, products: ['ATS'] })).rejects.toThrow(
        /DocumentTemplate_products_platform_only_check/,
      );
      await expect(insertTemplate({ tenant_id: TENANT, typeId, withdraw: true })).rejects.toThrow(
        /DocumentTemplate_withdraw_platform_only_check/,
      );
      const id = await insertTemplate({ owner_scope: 'PLATFORM', tenant_id: null, typeId, products: ['ATS', 'SIGN'], withdraw: true });
      const r = await db.query(`SELECT products FROM "documents"."DocumentTemplate" WHERE id = $1`, [id]);
      expect(r.rows[0].products).toEqual(['ATS', 'SIGN']);
    });

    // ── §3.2 version tenant = parent tenant ────────────────────────────────────
    it('TemplateVersion.tenant_id must equal the parent template tenant_id (INSERT and UPDATE)', async () => {
      const typeId = await newDocumentType();
      const tenantTpl = await insertTemplate({ tenant_id: TENANT, typeId });
      const platformTpl = await insertTemplate({ owner_scope: 'PLATFORM', tenant_id: null, typeId });
      await expect(insertVersion(tenantTpl, OTHER_TENANT, 1, 'DRAFT')).rejects.toThrow(/must equal its DocumentTemplate.tenant_id/);
      await expect(insertVersion(tenantTpl, null, 1, 'DRAFT')).rejects.toThrow(/must equal its DocumentTemplate.tenant_id/);
      await expect(insertVersion(platformTpl, TENANT, 1, 'DRAFT')).rejects.toThrow(/must equal its DocumentTemplate.tenant_id/);
      await expect(insertVersion(tenantTpl, TENANT, 1, 'DRAFT')).resolves.toBeTypeOf('string');
      await expect(insertVersion(platformTpl, null, 1, 'DRAFT')).resolves.toBeTypeOf('string');
    });

    // ── §3.3 one-DRAFT for NULL-tenant (PLATFORM) templates ────────────────────
    it('one-DRAFT uniqueness holds for a PLATFORM (NULL tenant) template', async () => {
      const typeId = await newDocumentType();
      const platformTpl = await insertTemplate({ owner_scope: 'PLATFORM', tenant_id: null, typeId });
      await insertVersion(platformTpl, null, 1, 'DRAFT');
      await expect(insertVersion(platformTpl, null, 2, 'DRAFT')).rejects.toThrow(/TemplateVersion_one_draft_per_template/);
      // A second DRAFT on a different PLATFORM template is fine.
      const other = await insertTemplate({ owner_scope: 'PLATFORM', tenant_id: null, typeId });
      await expect(insertVersion(other, null, 1, 'DRAFT')).resolves.toBeTypeOf('string');
    });

    it('one-DRAFT uniqueness still holds for TENANT templates (repository maps it to TEMPLATE_DRAFT_ALREADY_EXISTS)', async () => {
      const typeId = await newDocumentType();
      const t = await templates.createTemplate({ tenant_id: TENANT, document_type_id: typeId, name: 'T', template_kind: 'GENERATED', created_by: ACTOR });
      await templates.createVersion({ tenant_id: TENANT, template_id: t.id, render_schema_version: 'v1', created_by: ACTOR });
      await expect(
        templates.createVersion({ tenant_id: TENANT, template_id: t.id, render_schema_version: 'v1', created_by: ACTOR }),
      ).rejects.toBeInstanceOf(TemplateDraftAlreadyExistsError);
      await expect(insertVersion(t.id, TENANT, 9, 'DRAFT')).rejects.toThrow(/TemplateVersion_one_draft_per_template/);
    });

    // ── §3.4 immutability extension ────────────────────────────────────────────
    it('freezes tenant_id and template_id on every update (DRAFT included)', async () => {
      const typeId = await newDocumentType();
      const t1 = await insertTemplate({ tenant_id: TENANT, typeId });
      const t2 = await insertTemplate({ tenant_id: TENANT, typeId });
      const v = await insertVersion(t1, TENANT, 1, 'DRAFT');
      await expect(
        db.query(`UPDATE "documents"."TemplateVersion" SET template_id = $1 WHERE id = $2`, [t2, v]),
      ).rejects.toThrow(/tenant_id and template_id are immutable/);
      await expect(
        db.query(`UPDATE "documents"."TemplateVersion" SET tenant_id = $1 WHERE id = $2`, [OTHER_TENANT, v]),
      ).rejects.toThrow(/tenant_id and template_id are immutable/);
      // DRAFT content stays editable.
      await db.query(`UPDATE "documents"."TemplateVersion" SET field_schema = '{"blocks":["e"]}'::jsonb WHERE id = $1`, [v]);
    });

    it('freezes RETIRED content and makes RETIRED terminal, keeping ACTIVE -> RETIRED allowed', async () => {
      const typeId = await newDocumentType();
      const t = await insertTemplate({ tenant_id: TENANT, typeId });
      const v = await insertVersion(t, TENANT, 1, 'ACTIVE');
      await db.query(`UPDATE "documents"."TemplateVersion" SET status = 'RETIRED', retired_at = now() WHERE id = $1`, [v]);
      await expect(
        db.query(`UPDATE "documents"."TemplateVersion" SET field_schema = '{"blocks":["x"]}'::jsonb WHERE id = $1`, [v]),
      ).rejects.toThrow(/immutable after activation/);
      await expect(
        db.query(`UPDATE "documents"."TemplateVersion" SET render_schema_version = 'v2' WHERE id = $1`, [v]),
      ).rejects.toThrow(/immutable after activation/);
      await expect(db.query(`UPDATE "documents"."TemplateVersion" SET status = 'ACTIVE' WHERE id = $1`, [v])).rejects.toThrow(
        /RETIRED is terminal/,
      );
    });

    it('repository lifecycle is unchanged: create, edit, preview, activate, re-version, retire prior', async () => {
      const typeId = await newDocumentType();
      const t = await templates.createTemplate({ tenant_id: TENANT, document_type_id: typeId, name: 'L', template_kind: 'GENERATED', created_by: ACTOR });
      expect(t.owner_scope).toBe('TENANT');
      expect(t.tenant_id).toBe(TENANT);
      const v1 = await templates.createVersion({ tenant_id: TENANT, template_id: t.id, render_schema_version: 'v1', created_by: ACTOR });
      await templates.updateDraftVersion({ tenant_id: TENANT, version_id: v1.id, field_schema: { blocks: ['a'] }, internal_notes: 'n' });
      await templates.recordPreview({ tenant_id: TENANT, version_id: v1.id });
      await templates.activateVersion({ tenant_id: TENANT, version_id: v1.id, actor_id: ACTOR });
      const v2 = await templates.createDraftFromActive({ tenant_id: TENANT, template_id: t.id, created_by: ACTOR });
      await templates.recordPreview({ tenant_id: TENANT, version_id: v2.id });
      await templates.activateVersion({ tenant_id: TENANT, version_id: v2.id, actor_id: ACTOR });
      const versions = await templates.listVersions(TENANT, t.id);
      expect(versions.map((v) => v.status)).toEqual(['RETIRED', 'ACTIVE']);
    });

    // ── §3.6 TenantTemplateSelection ───────────────────────────────────────────
    it('selection uniqueness holds with a NULL client (two tenant-wide selections rejected)', async () => {
      const typeId = await newDocumentType();
      const tpl = await insertTemplate({ tenant_id: TENANT, typeId });
      await insertSelection({ tenant_id: TENANT, typeId, template_id: tpl });
      await expect(insertSelection({ tenant_id: TENANT, typeId, template_id: tpl })).rejects.toThrow(
        /TenantTemplateSelection_tenant_type_client_key/,
      );
      // A client-specific selection for the same tenant/type coexists, once.
      const client = randomUUID();
      await insertSelection({ tenant_id: TENANT, typeId, client_id: client, template_id: tpl });
      await expect(insertSelection({ tenant_id: TENANT, typeId, client_id: client, template_id: tpl })).rejects.toThrow(
        /TenantTemplateSelection_tenant_type_client_key/,
      );
    });

    it('a selection may target a PLATFORM template or its own TENANT template', async () => {
      const typeId = await newDocumentType();
      const platformTpl = await insertTemplate({ owner_scope: 'PLATFORM', tenant_id: null, typeId });
      await expect(insertSelection({ tenant_id: TENANT, typeId, template_id: platformTpl })).resolves.toBeTypeOf('string');
      await expect(insertSelection({ tenant_id: OTHER_TENANT, typeId, template_id: platformTpl })).resolves.toBeTypeOf('string');
    });

    it("the selection trigger rejects another tenant's template and a template of another document type", async () => {
      const typeId = await newDocumentType();
      const otherType = await newDocumentType();
      const foreignTpl = await insertTemplate({ tenant_id: OTHER_TENANT, typeId });
      await expect(insertSelection({ tenant_id: TENANT, typeId, template_id: foreignTpl })).rejects.toThrow(
        /PLATFORM template or a TENANT template of the same tenant/,
      );
      const ownWrongType = await insertTemplate({ tenant_id: TENANT, typeId: otherType });
      await expect(insertSelection({ tenant_id: TENANT, typeId, template_id: ownWrongType })).rejects.toThrow(
        /of the selected document type/,
      );
      const platformWrongType = await insertTemplate({ owner_scope: 'PLATFORM', tenant_id: null, typeId: otherType });
      await expect(insertSelection({ tenant_id: TENANT, typeId, template_id: platformWrongType })).rejects.toThrow(
        /of the selected document type/,
      );
      // UPDATE is guarded too.
      const ok = await insertTemplate({ tenant_id: TENANT, typeId });
      const sel = await insertSelection({ tenant_id: TENANT, typeId, client_id: randomUUID(), template_id: ok });
      await expect(
        db.query(`UPDATE "documents"."TenantTemplateSelection" SET template_id = $1 WHERE id = $2`, [foreignTpl, sel]),
      ).rejects.toThrow(/PLATFORM template or a TENANT template of the same tenant/);
    });

    // ── §3.7 TemplateVariable catalog ──────────────────────────────────────────
    it('seeds TemplateVariable with the 8 RTR binding keys (products ATS), no tenant_id column', async () => {
      const r = await db.query(
        `SELECT key, label, group_label, data_type, products, ats_binding_key, sample_value, active
           FROM "documents"."TemplateVariable" ORDER BY key`,
      );
      expect(r.rows).toHaveLength(8);
      expect(r.rows.map((x) => x.key)).toEqual([
        'client.name',
        'recruiter.display_name',
        'recruiting_company.name',
        'requisition.description',
        'requisition.reference',
        'requisition.title',
        'talent.desired_pay_rate',
        'talent.full_name',
      ]);
      for (const row of r.rows) {
        expect(row.products).toEqual(['ATS']);
        expect(row.ats_binding_key).toBe(row.key);
        expect(row.active).toBe(true);
        expect(typeof row.sample_value).toBe('string');
      }
      expect(r.rows.find((x) => x.key === 'requisition.description')?.data_type).toBe('MULTILINE_TEXT');
      const cols = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'documents' AND table_name = 'TemplateVariable'`,
      );
      const names = cols.rows.map((c) => c.column_name as string);
      expect(names).not.toContain('tenant_id');
      expect(names.filter((n) => n.includes('talent'))).toEqual([]);
      await expect(
        db.query(
          `INSERT INTO "documents"."TemplateVariable" (id, key, label, group_label, data_type) VALUES ($1,'x.y','X','G','SIGNATURE')`,
          [randomUUID()],
        ),
      ).rejects.toThrow(/TemplateVariable_data_type_check/);
    });

    // ── §4.1 read union + §4.4 owner-aware provenance ──────────────────────────
    it('owner-aware reads return own + PLATFORM rows, never another tenant; tenant-only reads unchanged', async () => {
      const typeId = await newDocumentType();
      const platformTpl = await insertTemplate({ owner_scope: 'PLATFORM', tenant_id: null, typeId });
      const platformVer = await insertVersion(platformTpl, null, 1, 'ACTIVE');
      const ownTpl = await insertTemplate({ tenant_id: TENANT, typeId });
      const ownVer = await insertVersion(ownTpl, TENANT, 1, 'ACTIVE');
      const foreignTpl = await insertTemplate({ tenant_id: OTHER_TENANT, typeId });
      const foreignVer = await insertVersion(foreignTpl, OTHER_TENANT, 1, 'ACTIVE');

      expect((await templates.findTemplateByIdOwnerAware(TENANT, platformTpl))?.owner_scope).toBe('PLATFORM');
      expect((await templates.findTemplateByIdOwnerAware(TENANT, ownTpl))?.id).toBe(ownTpl);
      expect(await templates.findTemplateByIdOwnerAware(TENANT, foreignTpl)).toBeNull();
      expect((await templates.findVersionByIdOwnerAware(TENANT, platformVer))?.id).toBe(platformVer);
      expect((await templates.findVersionByIdOwnerAware(TENANT, ownVer))?.id).toBe(ownVer);
      expect(await templates.findVersionByIdOwnerAware(TENANT, foreignVer)).toBeNull();

      const listed = (await templates.listTemplatesForTenantIncludingPlatform(TENANT, typeId)).map((t) => t.id);
      expect(listed.sort()).toEqual([platformTpl, ownTpl].sort());

      // Behaviour-neutral: tenant-only reads never surface PLATFORM rows.
      expect(await templates.findTemplateById(TENANT, platformTpl)).toBeNull();
      expect(await templates.findVersionById(TENANT, platformVer)).toBeNull();
      expect((await templates.listTemplates(TENANT)).map((t) => t.id)).not.toContain(platformTpl);
      expect(await templates.findActiveTenantTemplateForType(OTHER_TENANT, typeId)).not.toBeNull();
    });
  },
);
