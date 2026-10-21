import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PrismaService,
  TemplateDraftAlreadyExistsError,
  TemplateNotFoundError,
  TemplatePreviewRequiredError,
  TemplateVariableKeyConflictError,
  TemplateVariableNotFoundError,
  TemplateVariablesRepository,
  TemplateVersionNotFoundError,
  TemplatesRepository,
} from '../index.js';

// DOC-TEMPLATE-LIB-1 T-2 — repository level, real Postgres 17: the PLATFORM authoring
// primitives share the tenant DRAFT / preview-gate / activate code path but are reachable
// only through the platform* methods; the tenant methods (tenant_id equality) never match
// a PLATFORM row and the platform methods never match a TENANT row. Plus the variable
// catalog repository. Skipped unless ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');
const RTR = 'd0c50005-0000-7000-8000-000000000001';

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'DOC-TEMPLATE-LIB-1 T-2 — platform repository primitives + variable catalog — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let templates: TemplatesRepository;
    let variables: TemplateVariablesRepository;
    const TENANT = randomUUID();
    const ACTOR = randomUUID();

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
      prisma = new PrismaService(url);
      await prisma.$connect();
      templates = new TemplatesRepository(prisma);
      variables = new TemplateVariablesRepository(prisma);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    it('PLATFORM draft → preview gate → activate; tenant methods never match it', async () => {
      const t = await templates.createPlatformTemplate({
        document_type_id: RTR,
        name: 'Default',
        template_kind: 'GENERATED',
        products: ['ATS'],
        created_by: ACTOR,
      });
      expect(t).toMatchObject({ owner_scope: 'PLATFORM', tenant_id: null, products: ['ATS'], status: 'DRAFT' });
      const v = await templates.createPlatformVersion({
        template_id: t.id,
        render_schema_version: 'rtr-html-v1',
        field_schema: { title: 'T', html: '<p>x</p>' },
        created_by: ACTOR,
      });
      expect(v.tenant_id).toBeNull();
      await expect(
        templates.createPlatformVersion({ template_id: t.id, render_schema_version: 'rtr-html-v1', created_by: ACTOR }),
      ).rejects.toBeInstanceOf(TemplateDraftAlreadyExistsError);
      await expect(templates.activatePlatformVersion({ version_id: v.id, actor_id: ACTOR })).rejects.toBeInstanceOf(
        TemplatePreviewRequiredError,
      );
      await templates.recordPlatformPreview(v.id);
      const active = await templates.activatePlatformVersion({ version_id: v.id, actor_id: ACTOR });
      expect(active.status).toBe('ACTIVE');
      expect((await templates.getPlatformTemplate(t.id)).current_version_id).toBe(v.id);

      // Tenant methods: tenant_id equality never matches the PLATFORM row / version.
      await expect(templates.getTemplate(TENANT, t.id)).rejects.toBeInstanceOf(TemplateNotFoundError);
      await expect(templates.getVersion(TENANT, v.id)).rejects.toBeInstanceOf(TemplateVersionNotFoundError);
      await expect(templates.renameTemplate({ tenant_id: TENANT, id: t.id, name: 'x' })).rejects.toBeInstanceOf(TemplateNotFoundError);
      await expect(templates.createDraftFromActive({ tenant_id: TENANT, template_id: t.id, created_by: ACTOR })).rejects.toBeInstanceOf(
        TemplateNotFoundError,
      );
      expect((await templates.listTemplates(TENANT)).map((r) => r.id)).not.toContain(t.id);
      // …while the T-1 read union (Org Home / resolution, later increments) does include it.
      expect((await templates.listTemplatesForTenantIncludingPlatform(TENANT)).map((r) => r.id)).toContain(t.id);

      // Platform methods never match a TENANT row.
      const own = await templates.createTemplate({ tenant_id: TENANT, document_type_id: RTR, name: 'Own', template_kind: 'GENERATED', created_by: ACTOR });
      await expect(templates.getPlatformTemplate(own.id)).rejects.toBeInstanceOf(TemplateNotFoundError);
      await expect(templates.updatePlatformTemplate(own.id, { products: ['SIGN'] })).rejects.toBeInstanceOf(TemplateNotFoundError);
      expect((await templates.listPlatformTemplates()).map((r) => r.id)).not.toContain(own.id);
    });

    it('updatePlatformTemplate: name / description / products only', async () => {
      const t = await templates.createPlatformTemplate({ document_type_id: RTR, name: 'P', template_kind: 'GENERATED', products: [], created_by: ACTOR });
      const u = await templates.updatePlatformTemplate(t.id, { products: ['ATS', 'SIGN'], description: 'd' });
      expect(u).toMatchObject({ products: ['ATS', 'SIGN'], description: 'd', status: 'DRAFT', current_version_id: null });
    });

    // DOC-TEMPLATE-LIB-1 T-3 seeds 7 organization.* rows (migration 20261021140000) on top
    // of the 8 RTR rows, so the "new variable" example uses a key outside the seed.
    it('variable catalog: 15 seeded active rows; create / update / duplicate / not found', async () => {
      const seeded = await variables.listActive();
      expect(seeded).toHaveLength(15);
      expect(seeded.every((r) => r.ats_binding_key === r.key && r.products.includes('ATS'))).toBe(true);
      const created = await variables.create({
        key: 'organization.tax_id',
        label: 'Tax ID',
        group_label: 'Organization',
        data_type: 'TEXT',
        products: ['ATS', 'SIGN'],
        ats_binding_key: null,
        sample_value: 'Astre Consulting',
        active: true,
      });
      await expect(
        variables.create({ ...created, key: 'organization.tax_id', ats_binding_key: null, sample_value: null, data_type: 'TEXT' }),
      ).rejects.toBeInstanceOf(TemplateVariableKeyConflictError);
      const off = await variables.update(created.id, { active: false, label: 'Org name' });
      expect(off).toMatchObject({ key: 'organization.tax_id', active: false, label: 'Org name' });
      expect((await variables.listActive()).map((r) => r.key)).not.toContain('organization.tax_id');
      expect((await variables.listAll()).map((r) => r.key)).toContain('organization.tax_id');
      await expect(variables.update(randomUUID(), { label: 'x' })).rejects.toBeInstanceOf(TemplateVariableNotFoundError);
    });
  },
);
