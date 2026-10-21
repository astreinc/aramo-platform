import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import {
  DocumentTemplatesController,
  PrismaService,
  TemplateVariablesRepository,
  TemplatesRepository,
} from '@aramo/documents';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PlatformDocumentTemplatesController } from '../document-templates-platform/platform-document-templates.controller.js';
import { RtrTemplateCapabilities } from '../rtr/rtr-template-capabilities.service.js';
import { RIGHT_TO_REPRESENT_TYPE_ID } from '../rtr/rtr-constants.js';
import { RTR_BINDING_CATALOG } from '../rtr/rtr-template-content.js';

// DOC-TEMPLATE-LIB-1 T-2 (§6.1, §8.1, §2 F-7) on real Postgres 17 — the platform-tier
// authoring surface over the REAL repositories + the REAL catalog-driven capability:
//   - the seeded TemplateVariable catalog yields exactly the former 8-key code catalog;
//   - super_admin (platform consumer) creates, previews and publishes a PLATFORM default
//     (preview gate enforced; publishing v2 retires v1);
//   - the TENANT routes can neither see nor modify a PLATFORM row (tenant_id equality),
//     and the platform routes cannot reach a TENANT row;
//   - catalog edits flow into the editor catalog; a key without a resolver fails closed.
// Skipped unless ARAMO_RUN_INTEGRATION=1. Applies the documents module's own migrations.

const ROOT = resolve(__dirname, '../../../..');
const RID = 'req-t2';
const RTR = RIGHT_TO_REPRESENT_TYPE_ID;
const HTML = 'rtr-html-v1';

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

function authOf(consumer_type: string, tenant_id: string, scopes: string[]): AuthContextType {
  return {
    sub: randomUUID(),
    consumer_type: consumer_type as AuthContextType['consumer_type'],
    actor_kind: 'user' as AuthContextType['actor_kind'],
    tenant_id,
    scopes,
    iat: 0,
    exp: 0,
  };
}

async function errorOf(p: Promise<unknown>): Promise<{ code?: string; statusCode?: number; context?: { details?: Record<string, unknown> } }> {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; statusCode?: number };
  }
  return { code: 'NO_THROW' };
}

function html(title: string, body: string) {
  return { render_schema_version: HTML, title, html: body };
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'DOC-TEMPLATE-LIB-1 T-2 — platform Aramo default templates + variable catalog — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let platform: PlatformDocumentTemplatesController;
    let tenantRoutes: DocumentTemplatesController;
    let caps: RtrTemplateCapabilities;

    const TENANT = randomUUID();
    const SUPER = authOf('platform', '01900000-0000-7000-8000-000000000100', [
      'platform:document_template:read',
      'platform:document_template:manage',
    ]);
    const TENANT_ADMIN = authOf('recruiter', TENANT, ['document_template:read', 'document_template:manage']);

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of documentsMigrations()) await db.query(readFileSync(p, 'utf8'));
      prisma = new PrismaService(url);
      await prisma.$connect();
      const templates = new TemplatesRepository(prisma);
      const variables = new TemplateVariablesRepository(prisma);
      caps = new RtrTemplateCapabilities(variables);
      platform = new PlatformDocumentTemplatesController(templates, variables, caps);
      tenantRoutes = new DocumentTemplatesController(templates, caps);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    });

    it('the SEEDED catalog yields exactly the former code catalog (8 keys incl. A2 desired_pay_rate; labels, groups, order, samples)', async () => {
      const b = await caps.listAllowedBindings(RTR);
      expect(b).toEqual(RTR_BINDING_CATALOG.map((d) => ({ key: d.key, label: d.label, group: d.group })));
      expect(b.map((x) => x.key)).toContain('talent.desired_pay_rate');
      const p = await caps.renderSamplePreview({
        document_type_id: RTR,
        render_schema_version: HTML,
        field_schema: html('T', '<p>x</p>'),
        requestId: RID,
      });
      expect(p.sample_values).toEqual(RTR_BINDING_CATALOG.map((d) => ({ key: d.key, label: d.label, value: d.sample })));
      const listed = await platform.listVariables(SUPER, RID);
      expect(listed.variables.map((v) => v.key).sort()).toEqual(RTR_BINDING_CATALOG.map((d) => d.key).sort());
    });

    let platformTplId = '';
    let v1 = '';

    it('super_admin creates a PLATFORM default (no tenant), and the preview gate guards publish', async () => {
      const created = await platform.create(
        { document_type_id: RTR, name: 'Aramo standard RTR', template_kind: 'GENERATED', products: ['ATS'] },
        SUPER,
        RID,
      );
      platformTplId = created.id;
      const row = await db.query(`SELECT owner_scope, tenant_id, products FROM "documents"."DocumentTemplate" WHERE id = $1`, [platformTplId]);
      expect(row.rows[0]).toEqual({ owner_scope: 'PLATFORM', tenant_id: null, products: ['ATS'] });

      const draft = (await platform.createDraft(
        platformTplId,
        { render_schema_version: HTML, field_schema: html('Right to Represent', '<p>I authorize <span data-field="recruiting_company.name"></span> to represent <span data-field="talent.full_name"></span>.</p>') },
        SUPER,
        RID,
      )) as { id: string; tenant_id: string | null; status: string };
      v1 = draft.id;
      expect(draft).toMatchObject({ tenant_id: null, status: 'DRAFT' });

      // One DRAFT per PLATFORM template (the NULLS NOT DISTINCT index + app guard).
      expect((await errorOf(platform.createDraft(platformTplId, undefined, SUPER, RID))).code).toBe('TEMPLATE_DRAFT_ALREADY_EXISTS');

      // Preview gate: publish before preview is refused.
      const early = await errorOf(platform.publish(v1, SUPER, RID));
      expect(early).toMatchObject({ code: 'TEMPLATE_PREVIEW_REQUIRED', statusCode: 409 });

      const preview = await platform.preview(v1, SUPER, RID);
      expect(preview.html).toContain('<span data-sample="talent.full_name">Ravi Shankar</span>');

      // An edit after the preview re-arms the gate.
      await platform.updateDraft(v1, { field_schema: html('Right to Represent', '<p>Edited <span data-field="talent.full_name"></span>.</p>') }, SUPER, RID);
      expect((await errorOf(platform.publish(v1, SUPER, RID))).code).toBe('TEMPLATE_PREVIEW_REQUIRED');
      await platform.preview(v1, SUPER, RID);
      const published = (await platform.publish(v1, SUPER, RID)) as { status: string };
      expect(published.status).toBe('ACTIVE');

      const list = await platform.list(SUPER, RID);
      const mine = list.templates.find((t) => t.id === platformTplId);
      expect(mine).toMatchObject({ owner_scope: 'PLATFORM', products: ['ATS'], current_version: { id: v1, version_number: 1, status: 'ACTIVE' }, draft_version_id: null });
    });

    it('publishing v2 retires v1 — tenants only ever resolve the current version', async () => {
      const v2 = (await platform.createDraft(platformTplId, undefined, SUPER, RID)) as { id: string; version_number: number };
      expect(v2.version_number).toBe(2);
      await platform.updateDraft(v2.id, { field_schema: html('Right to Represent', '<p>v2 <span data-field="client.name"></span></p>') }, SUPER, RID);
      await platform.preview(v2.id, SUPER, RID);
      await platform.publish(v2.id, SUPER, RID);
      const r = await db.query(`SELECT id, status FROM "documents"."TemplateVersion" WHERE template_id = $1 ORDER BY version_number`, [platformTplId]);
      expect(r.rows).toEqual([
        { id: v1, status: 'RETIRED' },
        { id: v2.id, status: 'ACTIVE' },
      ]);
      const t = await db.query(`SELECT current_version_id FROM "documents"."DocumentTemplate" WHERE id = $1`, [platformTplId]);
      expect(t.rows[0].current_version_id).toBe(v2.id);
      // Published content is frozen (DB trigger + app guard).
      expect((await errorOf(platform.updateDraft(v2.id, { internal_notes: 'x' }, SUPER, RID))).code).toBe('TEMPLATE_IMMUTABLE');
    });

    it('TENANT routes can neither see nor modify a PLATFORM row (tenant_id equality)', async () => {
      const before = await db.query(
        `SELECT t.name, t.status, t.current_version_id, (SELECT count(*)::int FROM "documents"."TemplateVersion" v WHERE v.template_id = t.id) AS versions
           FROM "documents"."DocumentTemplate" t WHERE t.id = $1`,
        [platformTplId],
      );
      expect((await tenantRoutes.list(TENANT_ADMIN)).map((t) => t.id)).not.toContain(platformTplId);
      expect((await errorOf(tenantRoutes.get(TENANT_ADMIN, platformTplId, RID))).code).toBe('TEMPLATE_NOT_FOUND');
      expect((await errorOf(tenantRoutes.rename(TENANT_ADMIN, platformTplId, { name: 'hijack' }, RID))).code).toBe('TEMPLATE_NOT_FOUND');
      expect((await errorOf(tenantRoutes.createDraft(TENANT_ADMIN, platformTplId, RID))).code).toBe('TEMPLATE_NOT_FOUND');
      expect(
        (await errorOf(tenantRoutes.createVersion(TENANT_ADMIN, platformTplId, { render_schema_version: HTML, field_schema: html('x', '<p>x</p>') }, RID))).code,
      ).toBe('TEMPLATE_NOT_FOUND');
      expect((await errorOf(tenantRoutes.listVersions(TENANT_ADMIN, platformTplId, RID))).code).toBe('TEMPLATE_NOT_FOUND');
      expect((await errorOf(tenantRoutes.allowedBindings(TENANT_ADMIN, platformTplId, RID))).code).toBe('TEMPLATE_NOT_FOUND');

      // A PLATFORM DRAFT version is equally unreachable for reads and writes.
      const d3 = (await platform.createDraft(platformTplId, undefined, SUPER, RID)) as { id: string };
      expect((await errorOf(tenantRoutes.getVersion(TENANT_ADMIN, d3.id, RID))).code).toBe('TEMPLATE_VERSION_NOT_FOUND');
      expect((await errorOf(tenantRoutes.updateVersion(TENANT_ADMIN, d3.id, { field_schema: html('x', '<p>hijack</p>') }, RID))).code).toBe(
        'TEMPLATE_VERSION_NOT_FOUND',
      );
      expect((await errorOf(tenantRoutes.previewVersion(TENANT_ADMIN, d3.id, RID))).code).toBe('TEMPLATE_VERSION_NOT_FOUND');
      expect((await errorOf(tenantRoutes.activate(TENANT_ADMIN, d3.id, RID))).code).toBe('TEMPLATE_VERSION_NOT_FOUND');
      expect((await errorOf(tenantRoutes.deleteDraft(TENANT_ADMIN, d3.id, RID))).code).toBe('TEMPLATE_VERSION_NOT_FOUND');

      const after = await db.query(
        `SELECT t.name, t.status, t.current_version_id, (SELECT count(*)::int FROM "documents"."TemplateVersion" v WHERE v.template_id = t.id) AS versions
           FROM "documents"."DocumentTemplate" t WHERE t.id = $1`,
        [platformTplId],
      );
      // Only the platform-route draft (d3) was added; nothing the tenant tried changed.
      expect(after.rows[0]).toEqual({ ...before.rows[0], versions: before.rows[0].versions + 1 });
      const d3row = await db.query(`SELECT status, field_schema FROM "documents"."TemplateVersion" WHERE id = $1`, [d3.id]);
      expect(d3row.rows[0].status).toBe('DRAFT');
      expect(JSON.stringify(d3row.rows[0].field_schema)).not.toContain('hijack');
    });

    it('platform routes cannot reach a TENANT row', async () => {
      const tenantTpl = (await tenantRoutes.create(TENANT_ADMIN, { document_type_id: RTR, name: 'Our RTR', template_kind: 'GENERATED' }, RID)) as { id: string };
      const tv = (await tenantRoutes.createVersion(TENANT_ADMIN, tenantTpl.id, { render_schema_version: HTML, field_schema: html('Ours', '<p>x</p>') }, RID)) as { id: string };
      expect((await errorOf(platform.get(tenantTpl.id, SUPER, RID))).code).toBe('TEMPLATE_NOT_FOUND');
      expect((await errorOf(platform.update(tenantTpl.id, { products: ['SIGN'] }, SUPER, RID))).code).toBe('TEMPLATE_NOT_FOUND');
      expect((await errorOf(platform.getVersion(tv.id, SUPER, RID))).code).toBe('TEMPLATE_VERSION_NOT_FOUND');
      expect((await errorOf(platform.publish(tv.id, SUPER, RID))).code).toBe('TEMPLATE_VERSION_NOT_FOUND');
      expect((await platform.list(SUPER, RID)).templates.map((t) => t.id)).not.toContain(tenantTpl.id);
    });

    it('catalog edits flow into the editor catalog; a key without a resolver fails closed', async () => {
      const all = await platform.listVariables(SUPER, RID);
      const client = all.variables.find((v) => v.key === 'client.name')!;
      await platform.updateVariable(client.id, { label: 'Client company' }, SUPER, RID);
      expect((await platform.allowedBindings(platformTplId, SUPER, RID)).bindings.find((b) => b.key === 'client.name')?.label).toBe('Client company');
      await platform.updateVariable(client.id, { label: 'Client name' }, SUPER, RID);

      // DOC-TEMPLATE-LIB-1 T-3 seeds organization.address_* WITH resolvers, so the
      // no-resolver example uses a key that has none.
      await platform.createVariable(
        { key: 'organization.tax_id', label: 'Tax ID', group_label: 'Organization', data_type: 'TEXT', products: ['ATS', 'SIGN'], ats_binding_key: 'organization.tax_id', sample_value: '12-3456789' },
        SUPER,
        RID,
      );
      expect((await platform.allowedBindings(platformTplId, SUPER, RID)).bindings.map((b) => b.key)).not.toContain('organization.tax_id');
      const draft = (await platform.getVersion(
        (await db.query(`SELECT id FROM "documents"."TemplateVersion" WHERE template_id = $1 AND status = 'DRAFT'`, [platformTplId])).rows[0].id,
        SUPER,
        RID,
      )) as { id: string };
      const rejected = await errorOf(
        platform.updateDraft(draft.id, { field_schema: html('T', '<p><span data-field="organization.tax_id"></span></p>') }, SUPER, RID),
      );
      expect(rejected).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 422 });
      expect(rejected.context?.details?.['reason']).toBe('unknown_field');

      // Duplicate key → 409 key_exists.
      const dup = await errorOf(
        platform.createVariable({ key: 'talent.full_name', label: 'x', group_label: 'x', data_type: 'TEXT' }, SUPER, RID),
      );
      expect(dup.statusCode).toBe(409);
    });
  },
);
