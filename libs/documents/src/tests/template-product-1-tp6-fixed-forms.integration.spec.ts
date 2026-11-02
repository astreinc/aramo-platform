import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FIXED_FORM_SCHEMA_V1,
  FixedFormsRepository,
  PrismaService,
  TemplateDraftAlreadyExistsError,
  TemplateSelectionInvalidError,
  TemplatesRepository,
  emptyFixedFormContent,
} from '../index.js';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) TP-6 (§7) on real Postgres 17:
//   §7.1 PlatformTemplateAsset — table, CHECKs (PDF only, 10 MB, platform prefix), written once,
//        only for a DRAFT PLATFORM version, removed with a discarded draft (CASCADE);
//   §7.2 the fixed-form draft: first version empty, a new version copies the current PDF
//        reference + placed fields; every layout write re-arms the §18 preview gate; publish is
//        the shared activatePlatformVersion (preview gate + TP-1 tag check);
//   §7.3 a fixed form is never adopted; the published forms a tenant sees (product filter,
//        withdrawal in effect excluded); TenantTemplateVisibility Hide / Show (default shown);
//   §7.4 the frozen revision of a Sign "Use", pinned to the exact version;
// and an idempotent re-run of both migrations. Skipped unless ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATIONS = resolve(ROOT, 'libs/documents/prisma/migrations');
const TP6_ASSET = '20261103140000_template_product_1_platform_template_asset';
const TP6_VISIBILITY = '20261103140100_template_product_1_tenant_template_visibility';
const dirs = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((n) => /^\d/.test(n))
    .sort();
const sql = (name: string): string => readFileSync(resolve(MIGRATIONS, name, 'migration.sql'), 'utf8');

const SIGNING = { roles: [{ role_key: 'employee', label: 'Employee', kind: 'SIGNER', order: 1 }], routing_mode: 'PARALLEL' };
const SHA = 'a'.repeat(64);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('TEMPLATE-PRODUCT-1 TP-6 — fixed forms — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let forms: FixedFormsRepository;
  let templates: TemplatesRepository;
  const ACTOR = randomUUID();
  const TENANT = randomUUID();
  const OTHER = randomUUID();
  const I9 = randomUUID();
  const W4 = randomUUID();
  let i9Template = '';

  async function fixedType(id: string, key: string, products: string[]): Promise<void> {
    await db.query(
      `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class, system_defined, active, type_class, template_kind, products, category)
       VALUES ($1, NULL, $2, $2, 'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD', false, true, 'TEMPLATE', 'FIXED_FORM', $3::text[], 'Employment')`,
      [id, key, products],
    );
  }

  const field = (field_key: string, over: Record<string, unknown> = {}) => ({
    field_key,
    field_type: 'SIGNATURE',
    binding_key: null,
    signer_role: 'employee',
    required: true,
    page_number: 0,
    x: 72,
    y: 72,
    width: 160,
    height: 32,
    ordinal: 0,
    ...over,
  });

  // A published fixed form: DRAFT → PDF asset → layout → preview → publish (the shared path).
  async function publishForm(typeId: string, name: string, products: string[]) {
    const t = await templates.createPlatformTemplate({ document_type_id: typeId, name, template_kind: 'UPLOADED_PDF', products, created_by: ACTOR });
    const draft = await forms.createPlatformDraft({ template_id: t.id, created_by: ACTOR, initial: emptyFixedFormContent(name) });
    const asset = await forms.createPlatformAsset({
      template_version_id: draft.id,
      storage_key: `documents/platform/template-assets/${draft.id}/${SHA}.pdf`,
      sha256: SHA,
      byte_size: 1024,
      page_count: 1,
      created_by: ACTOR,
    });
    await forms.writePlatformDraft({
      version_id: draft.id,
      field_schema: {
        render_schema_version: FIXED_FORM_SCHEMA_V1,
        title: name,
        pdf: { asset_id: asset.id, sha256: SHA, byte_size: 1024, page_count: 1, pages: [{ width: 612, height: 792 }] },
        signing: SIGNING,
      },
      fields: [field('sig')],
    });
    await templates.recordPlatformPreview(draft.id);
    await templates.activatePlatformVersion({ version_id: draft.id, actor_id: ACTOR });
    return { template: t, version: draft, asset };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const n of dirs()) await db.query(sql(n));
    prisma = new PrismaService(url);
    await prisma.$connect();
    forms = new FixedFormsRepository(prisma);
    templates = new TemplatesRepository(prisma);
    await fixedType(I9, 'TP6_FORM_I9', ['sign']);
    await fixedType(W4, 'TP6_FORM_W4', ['ats']);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  it('both migrations re-run cleanly (idempotent)', async () => {
    await db.query(sql(TP6_ASSET));
    await db.query(sql(TP6_VISIBILITY));
    const cols = await db.query(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'documents' AND table_name IN ('PlatformTemplateAsset','TenantTemplateVisibility') ORDER BY table_name, ordinal_position`,
    );
    expect(cols.rows.filter((r) => r.table_name === 'TenantTemplateVisibility').map((r) => r.column_name)).toEqual(['tenant_id', 'template_id', 'hidden', 'updated_by', 'updated_at']);
    expect(cols.rows.filter((r) => r.table_name === 'PlatformTemplateAsset').map((r) => r.column_name)).toEqual([
      'id',
      'template_version_id',
      'storage_key',
      'mime',
      'sha256',
      'byte_size',
      'page_count',
      'created_at',
      'created_by',
    ]);
  });

  it('§7.1 the asset table accepts a PDF for a DRAFT PLATFORM version only, written once, within its CHECKs', async () => {
    const t = await templates.createPlatformTemplate({ document_type_id: I9, name: 'Asset rules', template_kind: 'UPLOADED_PDF', products: ['sign'], created_by: ACTOR });
    const draft = await forms.createPlatformDraft({ template_id: t.id, created_by: ACTOR, initial: emptyFixedFormContent('Asset rules') });
    const ok = await forms.createPlatformAsset({ template_version_id: draft.id, storage_key: `documents/platform/x/${SHA}.pdf`, sha256: SHA, byte_size: 10, page_count: 1, created_by: ACTOR });
    const insert = (over: Record<string, unknown>) =>
      db.query(
        `INSERT INTO "documents"."PlatformTemplateAsset" (id, template_version_id, storage_key, mime, sha256, byte_size, page_count, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [randomUUID(), over['v'] ?? draft.id, over['key'] ?? 'documents/platform/y.pdf', over['mime'] ?? 'application/pdf', over['sha'] ?? SHA, over['size'] ?? 10, over['pages'] ?? 1, ACTOR],
      );
    await expect(insert({ mime: 'image/png' })).rejects.toThrow(/PlatformTemplateAsset_mime_check/);
    await expect(insert({ size: 10 * 1024 * 1024 + 1 })).rejects.toThrow(/PlatformTemplateAsset_byte_size_check/);
    await expect(insert({ key: 'documents/tenant/y.pdf' })).rejects.toThrow(/PlatformTemplateAsset_storage_key_check/);
    await expect(insert({ pages: 0 })).rejects.toThrow(/PlatformTemplateAsset_page_count_check/);
    await expect(db.query(`UPDATE "documents"."PlatformTemplateAsset" SET page_count = 2 WHERE id = $1`, [ok.id])).rejects.toThrow(/written once/);
    // A tenant version is refused.
    const tenantTpl = await templates.createTemplate({ tenant_id: TENANT, document_type_id: I9, name: 'Tenant', template_kind: 'GENERATED', created_by: ACTOR });
    const tenantVer = await templates.createVersion({ tenant_id: TENANT, template_id: tenantTpl.id, render_schema_version: 'rtr-html-v1', created_by: ACTOR });
    await expect(insert({ v: tenantVer.id })).rejects.toThrow(/DRAFT PLATFORM template version/);
    // Discarding the draft removes its asset (CASCADE).
    await templates.deletePlatformDraftVersion({ version_id: draft.id, beforeDelete: async () => undefined });
    expect(await forms.findPlatformAsset(ok.id)).toBeNull();
  });

  it('§7.2 publish through the shared path; an ACTIVE version takes no asset; a new version copies the PDF + fields', async () => {
    const { template, version, asset } = await publishForm(I9, 'Form I-9', ['sign']);
    i9Template = template.id;
    const active = await templates.getPlatformVersion(version.id);
    expect(active.status).toBe('ACTIVE');
    await expect(
      forms.createPlatformAsset({ template_version_id: version.id, storage_key: `documents/platform/z/${SHA}.pdf`, sha256: SHA, byte_size: 1, page_count: 1, created_by: ACTOR }),
    ).rejects.toThrow();
    const v2 = await forms.createPlatformDraft({ template_id: template.id, created_by: ACTOR, initial: null });
    expect(v2.version_number).toBe(2);
    expect((v2.field_schema as { pdf: { asset_id: string } }).pdf.asset_id).toBe(asset.id);
    expect((await forms.listFields(v2.id)).map((f) => f.field_key)).toEqual(['sig']);
    expect(await forms.templateOwnsAsset(template.id, asset.id)).toBe(true);
    await expect(forms.createPlatformDraft({ template_id: template.id, created_by: ACTOR, initial: null })).rejects.toBeInstanceOf(TemplateDraftAlreadyExistsError);
    // Every layout write re-arms the preview gate.
    await templates.recordPlatformPreview(v2.id);
    await forms.writePlatformDraft({ version_id: v2.id, fields: [field('sig'), field('date', { field_type: 'SIGN_DATE', ordinal: 1 })] });
    const after = await templates.getPlatformVersion(v2.id);
    expect(after.previewed_fingerprint).toBeNull();
    await forms.addPlatformDraftField({ version_id: v2.id, field: field('initials', { field_type: 'INITIALS', ordinal: 2 }) });
    expect((await forms.listFields(v2.id)).map((f) => f.field_key)).toEqual(['sig', 'date', 'initials']);
  });

  it('§7.3 a fixed form is never adopted', async () => {
    let reason = '';
    try {
      await templates.adoptPlatformTemplate({ tenant_id: TENANT, library_template_id: i9Template, created_by: ACTOR });
    } catch (e) {
      if (e instanceof TemplateSelectionInvalidError) reason = e.reason;
      else throw e;
    }
    expect(reason).toBe('fixed_form_not_adoptable');
  });

  it('§7.3 published forms by product; Hide / Show per tenant, default shown', async () => {
    const w4 = await publishForm(W4, 'Form W-4', ['ats']);
    const signOnly = (await forms.listPublishedFixedForms({ now: new Date(), products: ['sign'] })).map((f) => f.template.name);
    expect(signOnly).toContain('Form I-9');
    expect(signOnly).not.toContain('Form W-4');
    const atsOnly = (await forms.listPublishedFixedForms({ now: new Date(), products: ['ats'] })).map((f) => f.template.name);
    expect(atsOnly).toEqual(['Form W-4']);

    expect((await forms.visibilityFor(TENANT)).get(w4.template.id)).toBeUndefined();
    expect(await forms.setVisibility({ tenant_id: TENANT, template_id: w4.template.id, hidden: true, updated_by: ACTOR })).toBe(false);
    expect((await forms.visibilityFor(TENANT)).get(w4.template.id)).toBe(true);
    expect((await forms.visibilityFor(OTHER)).get(w4.template.id)).toBeUndefined();
    expect(await forms.setVisibility({ tenant_id: TENANT, template_id: w4.template.id, hidden: false, updated_by: ACTOR })).toBe(true);
    expect((await forms.visibilityFor(TENANT)).get(w4.template.id)).toBe(false);

    // A withdrawal in effect removes the form.
    await db.query(`UPDATE "documents"."DocumentTemplate" SET withdraw_notice_at = now() - interval '2 days', withdraw_effective_at = now() - interval '1 day' WHERE id = $1`, [w4.template.id]);
    expect(await forms.listPublishedFixedForms({ now: new Date(), products: ['ats'] })).toEqual([]);
  });

  it('§7.4 the frozen revision of a Sign "Use" is pinned to the exact version', async () => {
    const [form] = await forms.listPublishedFixedForms({ now: new Date(), products: ['sign'] });
    expect(form).toBeDefined();
    const docId = randomUUID();
    await db.query(
      `INSERT INTO "documents"."Document" (id, tenant_id, document_type_id, template_version_id, title, status, execution_mode, source_kind, created_by)
       VALUES ($1, $2, $3, NULL, 'Form I-9', 'DRAFT', 'SINGLE_SIGNATURE', 'TEMPLATE_GENERATED', $4)`,
      [docId, TENANT, form!.type.id, ACTOR],
    );
    await forms.writeFrozenRevision({
      tenant_id: TENANT,
      document_id: docId,
      template_version_id: form!.version.id,
      storage_key: `documents/${TENANT}/${docId}/rendered/${SHA}.pdf`,
      sha256: SHA,
      byte_size: 1024,
      render_manifest: { fixed_form: { template_id: form!.template.id, source_sha256: SHA, prefilled_keys: [] } },
      actor_id: ACTOR,
    });
    const rev = await db.query(`SELECT status, template_version_id, content_sha256, frozen_at FROM "documents"."DocumentRevision" WHERE document_id = $1`, [docId]);
    expect(rev.rows).toEqual([expect.objectContaining({ status: 'FROZEN', template_version_id: form!.version.id, content_sha256: SHA })]);
    expect(rev.rows[0].frozen_at).not.toBeNull();
    const art = await db.query(`SELECT artifact_role, immutability_state FROM "documents"."DocumentArtifact" WHERE document_id = $1`, [docId]);
    expect(art.rows).toEqual([{ artifact_role: 'RENDERED_UNSIGNED', immutability_state: 'FROZEN' }]);
  });
});
