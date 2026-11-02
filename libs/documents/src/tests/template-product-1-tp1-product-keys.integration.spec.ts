import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService, TemplateProductRequiredError, TemplatesRepository } from '../index.js';

// TEMPLATE-PRODUCT-1 TP-1 (§2.4, §2.6) on real Postgres 17: the guarded lowercase migration
// (ATS → ats, SIGN → sign, duplicates collapsed in first-seen order, NULL / empty kept,
// fail closed on an unknown value, idempotent re-run) and the publish rule (an untagged
// Aramo default is refused with TemplateProductRequiredError). Skipped unless
// ARAMO_RUN_INTEGRATION=1. Applies the documents migrations BEFORE TP-1, seeds legacy
// upper-case values, then applies TP-1 itself.

const ROOT = resolve(__dirname, '../../../..');
const TP1 = '20261103100000_template_product_1_lowercase_product_keys';

function migrationDirs(): string[] {
  return readdirSync(resolve(ROOT, 'libs/documents/prisma/migrations'))
    .filter((n) => /^\d/.test(n))
    .sort();
}
const sql = (name: string): string => readFileSync(resolve(ROOT, 'libs/documents/prisma/migrations', name, 'migration.sql'), 'utf8');

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('TEMPLATE-PRODUCT-1 TP-1 — product keys — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let templates: TemplatesRepository;
  const ACTOR = randomUUID();
  let typeId: string;

  async function insertPlatform(products: string[] | null): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO "documents"."DocumentTemplate" (id, owner_scope, tenant_id, document_type_id, name, template_kind, status, products, created_by)
       VALUES ($1,'PLATFORM',NULL,$2,'P','GENERATED','DRAFT',$3,$4)`,
      [id, typeId, products, ACTOR],
    );
    return id;
  }
  const productsOf = async (id: string): Promise<string[] | null> =>
    (await db.query(`SELECT products FROM "documents"."DocumentTemplate" WHERE id = $1`, [id])).rows[0].products;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const n of migrationDirs().filter((d) => d < TP1)) await db.query(sql(n));
    typeId = randomUUID();
    await db.query(
      `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class)
       VALUES ($1, NULL, $2, 'Doc', 'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD')`,
      [typeId, `TP1_${typeId.slice(0, 8)}`],
    );
    prisma = new PrismaService(url);
    await prisma.$connect();
    templates = new TemplatesRepository(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  it('fails closed on an unknown value and rewrites nothing', async () => {
    const legacy = await insertPlatform(['ATS']);
    const bad = await insertPlatform(['ATS', 'PORTAL']);
    await expect(db.query(sql(TP1))).rejects.toThrow(/unknown DocumentTemplate product tags.*PORTAL/);
    expect(await productsOf(legacy)).toEqual(['ATS']);
    await db.query(`DELETE FROM "documents"."DocumentTemplate" WHERE id = ANY($1::uuid[])`, [[legacy, bad]]);
    await db.query(`UPDATE "documents"."TemplateVariable" SET products = ARRAY['ATS','SMS'] WHERE key = 'talent.full_name'`);
    await expect(db.query(sql(TP1))).rejects.toThrow(/unknown TemplateVariable product tags.*talent\.full_name: SMS/);
    await db.query(`UPDATE "documents"."TemplateVariable" SET products = ARRAY['ATS'] WHERE key = 'talent.full_name'`);
  });

  it('lowercases templates and the seeded variable catalog (15 rows: 8 ats, 7 ats+sign); idempotent', async () => {
    const both = await insertPlatform(['SIGN', 'ATS', 'sign']);
    const empty = await insertPlatform([]);
    const none = await insertPlatform(null);
    await db.query(sql(TP1));
    expect(await productsOf(both)).toEqual(['sign', 'ats']);
    expect(await productsOf(empty)).toEqual([]);
    expect(await productsOf(none)).toBeNull();
    const vars = (await db.query(`SELECT key, products FROM "documents"."TemplateVariable" ORDER BY key`)).rows as Array<{ key: string; products: string[] }>;
    expect(vars).toHaveLength(15);
    expect(vars.filter((v) => JSON.stringify(v.products) === '["ats"]')).toHaveLength(8);
    expect(vars.filter((v) => JSON.stringify(v.products) === '["ats","sign"]')).toHaveLength(7);
    const before = (await db.query(`SELECT id, xmin::text AS x FROM "documents"."DocumentTemplate" ORDER BY id`)).rows;
    await db.query(sql(TP1));
    expect((await db.query(`SELECT id, xmin::text AS x FROM "documents"."DocumentTemplate" ORDER BY id`)).rows).toEqual(before);
    // The remaining migrations still apply on top (the build order of every environment).
    for (const n of migrationDirs().filter((d) => d > TP1)) await db.query(sql(n));
  });

  it('publishing an untagged Aramo default is refused; once tagged it publishes', async () => {
    const t = await templates.createPlatformTemplate({ document_type_id: typeId, name: 'Untagged', template_kind: 'GENERATED', products: [], created_by: ACTOR });
    const v = await templates.createPlatformVersion({ template_id: t.id, render_schema_version: 'v1', field_schema: { blocks: [] }, created_by: ACTOR });
    await templates.recordPlatformPreview(v.id);
    await expect(templates.activatePlatformVersion({ version_id: v.id, actor_id: ACTOR })).rejects.toBeInstanceOf(TemplateProductRequiredError);
    expect((await templates.getPlatformTemplate(t.id)).status).toBe('DRAFT');
    await templates.updatePlatformTemplate(t.id, { products: ['sign'] });
    expect((await templates.activatePlatformVersion({ version_id: v.id, actor_id: ACTOR })).status).toBe('ACTIVE');
  });
});
