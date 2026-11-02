import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DocumentTypeConflictError,
  OFFER_LETTER_TYPE_ID,
  PlatformDocumentTypesRepository,
  PrismaService,
  RIGHT_TO_REPRESENT_TYPE_ID,
  TemplatesRepository,
} from '../index.js';

// TEMPLATE-PRODUCT-1 TP-3 (§4.1–§4.4) on real Postgres 17: the ADD-only DocumentType columns
// and their backfill (TALENT_* → UPLOAD, RTR → EDITABLE {ats,sign} Recruiting, every other
// row TEMPLATE with no kind), the CHECKs and the SYSTEM key index, an idempotent re-run, the
// Platform Admin repository rules (system-locked fields, kind / product locks once a template
// exists, retire refused while a default is live, delete only unreferenced non-seeded types),
// and the "New template" type list (active TEMPLATE types with a kind). Skipped unless
// ARAMO_RUN_INTEGRATION=1. The six TALENT_* rows (seeded by talent-evidence in a full
// environment) are inserted before TP-3 runs, as the cross-lib migration order does.

const ROOT = resolve(__dirname, '../../../..');
const TP3 = '20261103110000_template_product_1_document_type_classes';
const TALENT_KEYS = ['TALENT_RESUME', 'TALENT_COVER_LETTER', 'TALENT_CERTIFICATION', 'TALENT_WORK_SAMPLE', 'TALENT_REFERENCE_LETTER', 'TALENT_OTHER'];

const dirs = (): string[] =>
  readdirSync(resolve(ROOT, 'libs/documents/prisma/migrations'))
    .filter((n) => /^\d/.test(n))
    .sort();
const sql = (name: string): string => readFileSync(resolve(ROOT, 'libs/documents/prisma/migrations', name, 'migration.sql'), 'utf8');

async function conflictReason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DocumentTypeConflictError) return e.reason;
    throw e;
  }
  throw new Error('expected DocumentTypeConflictError');
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('TEMPLATE-PRODUCT-1 TP-3 — document types — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let types: PlatformDocumentTypesRepository;
  let templates: TemplatesRepository;
  const ACTOR = randomUUID();

  const typeRow = async (key: string) =>
    (await db.query(`SELECT type_class, template_kind, products, category FROM "documents"."DocumentType" WHERE key = $1 AND tenant_id IS NULL`, [key])).rows[0];

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const n of dirs().filter((d) => d < TP3)) await db.query(sql(n));
    for (const [i, key] of TALENT_KEYS.entries()) {
      await db.query(
        `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class, system_defined, active)
         VALUES ($1, NULL, $2, $2, 'SYSTEM', 'NO_SIGNATURE', 'TALENT_DOCUMENT', true, true)`,
        [`01900000-0000-7000-8000-0000000002d${i + 1}`, key],
      );
    }
    for (const n of dirs().filter((d) => d >= TP3)) await db.query(sql(n));
    prisma = new PrismaService(url);
    await prisma.$connect();
    types = new PlatformDocumentTypesRepository(prisma);
    templates = new TemplatesRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  it('backfills exactly §4.1 and re-runs idempotently', async () => {
    for (const key of TALENT_KEYS) expect(await typeRow(key), key).toEqual({ type_class: 'UPLOAD', template_kind: null, products: [], category: null });
    expect(await typeRow('RIGHT_TO_REPRESENT')).toEqual({ type_class: 'TEMPLATE', template_kind: 'EDITABLE', products: ['ats', 'sign'], category: 'Recruiting' });
    for (const key of ['OFFER_LETTER', 'CLIENT_NDA', 'BACKGROUND_AUTHORIZATION', 'I9']) {
      expect(await typeRow(key), key).toEqual({ type_class: 'TEMPLATE', template_kind: null, products: [], category: null });
    }
    await db.query(`UPDATE "documents"."DocumentType" SET category = 'Talent' WHERE id = $1`, [RIGHT_TO_REPRESENT_TYPE_ID]);
    await db.query(sql(TP3));
    expect((await typeRow('RIGHT_TO_REPRESENT')).category).toBe('Talent');
    await db.query(`UPDATE "documents"."DocumentType" SET category = 'Recruiting' WHERE id = $1`, [RIGHT_TO_REPRESENT_TYPE_ID]);
  });

  it('CHECKs: class / kind / products values; an UPLOAD row carries no kind or products; SYSTEM keys are unique', async () => {
    const talent = '01900000-0000-7000-8000-0000000002d1';
    await expect(db.query(`UPDATE "documents"."DocumentType" SET template_kind = 'EDITABLE' WHERE id = $1`, [talent])).rejects.toThrow(/DocumentType_upload_not_template_check/);
    await expect(db.query(`UPDATE "documents"."DocumentType" SET products = ARRAY['ATS'] WHERE id = $1`, [RIGHT_TO_REPRESENT_TYPE_ID])).rejects.toThrow(/DocumentType_products_check/);
    await expect(db.query(`UPDATE "documents"."DocumentType" SET template_kind = 'HYBRID' WHERE id = $1`, [RIGHT_TO_REPRESENT_TYPE_ID])).rejects.toThrow(/DocumentType_template_kind_check/);
    await expect(
      db.query(
        `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class) VALUES ($1, NULL, 'I9', 'Dup', 'SYSTEM', 'NO_SIGNATURE', 'CONTRACT_RECORD')`,
        [randomUUID()],
      ),
    ).rejects.toThrow(/DocumentType_system_key_key/);
    // A tenant may still reuse a SYSTEM key for its own type (index is SYSTEM-only).
    await db.query(
      `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class) VALUES ($1, $2, 'I9', 'Own', 'TENANT', 'NO_SIGNATURE', 'CONTRACT_RECORD')`,
      [randomUUID(), randomUUID()],
    );
  });

  it('New template offers only active TEMPLATE types with a kind (RTR after backfill)', async () => {
    expect((await templates.listTemplateDocumentTypes()).map((t) => t.key)).toEqual(['RIGHT_TO_REPRESENT']);
  });

  it('create: SYSTEM TEMPLATE, not seeded; a taken key is key_exists; list carries usage', async () => {
    const t = await types.create({ key: 'MUTUAL_NDA', name: 'Mutual NDA', description: null, category: 'Legal', template_kind: 'EDITABLE', products: ['sign'], retention_class: 'CONTRACT_RECORD', execution_mode_default: 'MULTI_SIGNATURE' });
    expect(t).toMatchObject({ scope: 'SYSTEM', tenant_id: null, system_defined: false, type_class: 'TEMPLATE', template_kind: 'EDITABLE', products: ['sign'], active: true });
    expect(await conflictReason(types.create({ key: 'MUTUAL_NDA', name: 'Mutual NDA', description: null, category: null, template_kind: 'EDITABLE', products: ['sign'], retention_class: 'CONTRACT_RECORD', execution_mode_default: 'MULTI_SIGNATURE' }))).toBe('key_exists');
    expect((await templates.listTemplateDocumentTypes()).map((x) => x.key)).toEqual(['MUTUAL_NDA', 'RIGHT_TO_REPRESENT']);
    const listed = (await types.listWithUsage()).find((x) => x.id === t.id);
    expect(listed).toMatchObject({ templates_count: 0, live_default: false });
  });

  it('system-locked fields (§4.2) and UPLOAD rows are refused; unchanged values pass through', async () => {
    expect(await conflictReason(types.update(RIGHT_TO_REPRESENT_TYPE_ID, { template_kind: 'FIXED_FORM' }))).toBe('system_locked');
    expect(await conflictReason(types.update(RIGHT_TO_REPRESENT_TYPE_ID, { retention_class: 'TALENT_DOCUMENT' }))).toBe('system_locked');
    expect((await types.update(RIGHT_TO_REPRESENT_TYPE_ID, { template_kind: 'EDITABLE', name: 'Right to Represent (RTR)' })).changed_fields).toEqual(['name']);
    expect(await conflictReason(types.update(OFFER_LETTER_TYPE_ID, { name: 'Offer' }))).toBe('system_locked');
    expect((await types.update(OFFER_LETTER_TYPE_ID, { description: 'Offer letter.' })).changed_fields).toEqual(['description']);
    expect(await conflictReason(types.update('01900000-0000-7000-8000-0000000002d1', { name: 'Resume' }))).toBe('upload_type');
    expect(await conflictReason(types.retire(RIGHT_TO_REPRESENT_TYPE_ID))).toBe('system_locked');
    expect(await conflictReason(types.delete(OFFER_LETTER_TYPE_ID))).toBe('system_locked');
  });

  it('once a template exists: kind fixed, products can be added not removed; retire refused while a default is live; delete refused', async () => {
    const t = await types.create({ key: 'LEASE', name: 'Lease', description: null, category: 'Real estate', template_kind: 'EDITABLE', products: ['sign'], retention_class: 'CONTRACT_RECORD', execution_mode_default: 'MULTI_SIGNATURE' });
    const d = await templates.createPlatformTemplate({ document_type_id: t.id, name: 'Lease', template_kind: 'GENERATED', products: ['sign'], created_by: ACTOR });
    expect(await conflictReason(types.update(t.id, { template_kind: 'FIXED_FORM' }))).toBe('kind_in_use');
    expect((await types.update(t.id, { products: ['ats', 'sign'] })).type.products).toEqual(['ats', 'sign']);
    expect(await conflictReason(types.update(t.id, { products: ['ats'] }))).toBe('product_in_use');
    const v = await templates.createPlatformVersion({ template_id: d.id, render_schema_version: 'v1', field_schema: { blocks: [] }, created_by: ACTOR });
    await templates.recordPlatformPreview(v.id);
    await templates.activatePlatformVersion({ version_id: v.id, actor_id: ACTOR });
    expect(await conflictReason(types.retire(t.id))).toBe('live_default');
    expect(await conflictReason(types.delete(t.id))).toBe('in_use');
    await templates.withdrawPlatformTemplate({ id: d.id, notice_days: 0 });
    expect((await types.retire(t.id)).active).toBe(false);
    expect((await templates.listTemplateDocumentTypes()).some((x) => x.id === t.id)).toBe(false);
  });

  it('delete: an unreferenced type created here; a seeded one never; the hook runs last and aborts on failure', async () => {
    const t = await types.create({ key: 'SCRATCH', name: 'Scratch', description: null, category: null, template_kind: 'FIXED_FORM', products: ['sign'], retention_class: 'CONTRACT_RECORD', execution_mode_default: 'SINGLE_SIGNATURE' });
    await expect(types.delete(t.id, async () => Promise.reject(new Error('audit down')))).rejects.toThrow('audit down');
    await types.delete(t.id);
    expect((await db.query(`SELECT 1 FROM "documents"."DocumentType" WHERE id = $1`, [t.id])).rowCount).toBe(0);
    const i9 = (await db.query(`SELECT id FROM "documents"."DocumentType" WHERE key = 'I9' AND tenant_id IS NULL`)).rows[0].id as string;
    expect(await conflictReason(types.delete(i9))).toBe('seeded');
  });
});
