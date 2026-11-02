import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService, RIGHT_TO_REPRESENT_TYPE_ID, TemplateResolutionService, TemplatesRepository } from '../index.js';

// TEMPLATE-PRODUCT-1 TP-5 (§6.1/§6.2) on real Postgres 17: migration 20261103120000 replaces the
// PLATFORM-only products CHECK (PLATFORM non-null; TENANT may carry tags), backfills the platform
// RTR default {ats,sign} and every tenant template with its type's products, adds the BEFORE
// INSERT trigger that copies the type's products onto a row inserted without them, and is
// idempotent. The repository writes tenant tags server-side (type at create, copied at Adopt) and
// resolution with a product resolves only templates tagged with it. Skipped unless
// ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');
const TP5 = '20261103120000_template_product_1_tenant_product_tags';
const dirs = (): string[] =>
  readdirSync(resolve(ROOT, 'libs/documents/prisma/migrations'))
    .filter((n) => /^\d/.test(n))
    .sort();
const sql = (name: string): string => readFileSync(resolve(ROOT, 'libs/documents/prisma/migrations', name, 'migration.sql'), 'utf8');

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('TEMPLATE-PRODUCT-1 TP-5 — tenant product tags — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let templates: TemplatesRepository;
  const TENANT = randomUUID();
  const ACTOR = randomUUID();
  const SIGN_TYPE = randomUUID();
  let platformRtr = '';
  let tenantRtr = '';
  let tenantSign = '';
  let platformNull = '';

  const productsOf = async (id: string): Promise<string[] | null> =>
    (await db.query(`SELECT products FROM "documents"."DocumentTemplate" WHERE id = $1`, [id])).rows[0].products;
  async function insert(args: { owner: 'PLATFORM' | 'TENANT'; type: string; products?: string[] | null; status?: string }): Promise<string> {
    const id = randomUUID();
    const cols = ['id', 'owner_scope', 'tenant_id', 'document_type_id', 'name', 'template_kind', 'status', 'created_by'];
    const vals: unknown[] = [id, args.owner, args.owner === 'PLATFORM' ? null : TENANT, args.type, 'T', 'GENERATED', args.status ?? 'DRAFT', ACTOR];
    if (args.products !== undefined) {
      cols.push('products');
      vals.push(args.products);
    }
    await db.query(
      `INSERT INTO "documents"."DocumentTemplate" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(', ')})`,
      vals,
    );
    return id;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    // Every migration BEFORE TP-5, then the pre-TP-5 data shapes the backfill must handle.
    for (const n of dirs().filter((d) => d < TP5)) await db.query(sql(n));
    await db.query(
      `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class, system_defined, active, type_class, template_kind, products)
       VALUES ($1, NULL, 'TP5_SIGN_ONLY', 'Sign only', 'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD', false, true, 'TEMPLATE', 'EDITABLE', ARRAY['sign'])`,
      [SIGN_TYPE],
    );
    // The documents-only container has no "identity"."Tenant", so T-3 (20261021140100) skips
    // creating the Aramo RTR default here. Seed its pre-TP-5 shape (PLATFORM, NULL products) so
    // the §6.2 RTR backfill has a row to act on.
    platformRtr = await insert({ owner: 'PLATFORM', type: RIGHT_TO_REPRESENT_TYPE_ID, products: null });
    tenantRtr = await insert({ owner: 'TENANT', type: RIGHT_TO_REPRESENT_TYPE_ID });
    tenantSign = await insert({ owner: 'TENANT', type: SIGN_TYPE });
    platformNull = await insert({ owner: 'PLATFORM', type: SIGN_TYPE, products: null });
    for (const n of dirs().filter((d) => d >= TP5)) await db.query(sql(n));
    prisma = new PrismaService(url);
    templates = new TemplatesRepository(prisma);
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  }, 60_000);

  it('§6.2 backfill — the platform RTR default {ats,sign}; tenant templates get their type products; other PLATFORM NULL → {}', async () => {
    const rtrDefault = (await db.query(`SELECT products FROM "documents"."DocumentTemplate" WHERE owner_scope = 'PLATFORM' AND document_type_id = $1`, [RIGHT_TO_REPRESENT_TYPE_ID])).rows;
    expect(rtrDefault.length).toBeGreaterThan(0);
    for (const r of rtrDefault) expect(r.products).toEqual(['ats', 'sign']);
    expect(await productsOf(platformRtr)).toEqual(['ats', 'sign']);
    expect(await productsOf(tenantRtr)).toEqual(['ats', 'sign']);
    expect(await productsOf(tenantSign)).toEqual(['sign']);
    expect(await productsOf(platformNull)).toEqual([]);
  });

  it('§6.1 the CHECK — PLATFORM products non-null; TENANT rows may carry tags; the old CHECK is gone', async () => {
    const names = (await db.query(`SELECT conname FROM pg_constraint WHERE conname LIKE 'DocumentTemplate_products_%'`)).rows.map((r) => r.conname);
    expect(names).toEqual(['DocumentTemplate_products_platform_not_null_check']);
    await expect(db.query(`UPDATE "documents"."DocumentTemplate" SET products = NULL WHERE id = $1`, [platformNull])).rejects.toThrow(
      /DocumentTemplate_products_platform_not_null_check/,
    );
    const explicit = await insert({ owner: 'TENANT', type: RIGHT_TO_REPRESENT_TYPE_ID, products: ['ats'] });
    expect(await productsOf(explicit)).toEqual(['ats']);
  });

  it('§6.1 the trigger — a row inserted without products takes its type products (never overrides set ones)', async () => {
    expect(await productsOf(await insert({ owner: 'TENANT', type: SIGN_TYPE }))).toEqual(['sign']);
    expect(await productsOf(await insert({ owner: 'PLATFORM', type: SIGN_TYPE }))).toEqual(['sign']);
    expect(await productsOf(await insert({ owner: 'TENANT', type: SIGN_TYPE, products: [] }))).toEqual([]);
  });

  it('is idempotent — a re-run changes nothing and keeps one trigger', async () => {
    const before = (await db.query(`SELECT id, products FROM "documents"."DocumentTemplate" ORDER BY id`)).rows;
    await db.query(sql(TP5));
    expect((await db.query(`SELECT id, products FROM "documents"."DocumentTemplate" ORDER BY id`)).rows).toEqual(before);
    const trig = await db.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'document_template_products_from_type'`);
    expect(trig.rows[0].n).toBe(1);
  });

  it('§6.1 repository — createTemplate takes the type products; Adopt copies the default tags', async () => {
    const created = await templates.createTemplate({ tenant_id: TENANT, document_type_id: SIGN_TYPE, name: 'Mine', template_kind: 'GENERATED', created_by: ACTOR });
    expect(created.products).toEqual(['sign']);
    // A live Aramo default of the sign-only type, tagged {sign}.
    const def = await templates.createPlatformTemplate({ document_type_id: SIGN_TYPE, name: 'Default', template_kind: 'GENERATED', products: ['sign'], created_by: ACTOR });
    const ver = randomUUID();
    await db.query(
      `INSERT INTO "documents"."TemplateVersion" (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by, activated_at)
       VALUES ($1, NULL, $2, 1, 'ACTIVE', 'rtr-html-v1', '{"render_schema_version":"rtr-html-v1","title":"D","html":"<p>D</p>","logo":null}'::jsonb, $3, now())`,
      [ver, def.id, ACTOR],
    );
    await db.query(`UPDATE "documents"."DocumentTemplate" SET status = 'ACTIVE', current_version_id = $2 WHERE id = $1`, [def.id, ver]);
    const adopted = await templates.adoptPlatformTemplate({ tenant_id: TENANT, library_template_id: def.id, created_by: ACTOR });
    expect(adopted.template.products).toEqual(['sign']);
  });

  it('§6.3 resolution with a product — only templates tagged with it resolve', async () => {
    const id = await insert({ owner: 'TENANT', type: SIGN_TYPE, products: ['sign'], status: 'ACTIVE' });
    const ver = randomUUID();
    await db.query(
      `INSERT INTO "documents"."TemplateVersion" (id, tenant_id, template_id, version_number, status, render_schema_version, field_schema, created_by, activated_at)
       VALUES ($1, $2, $3, 1, 'ACTIVE', 'rtr-html-v1', '{"render_schema_version":"rtr-html-v1","title":"S","html":"<p>S</p>","logo":null}'::jsonb, $4, now())`,
      [ver, TENANT, id, ACTOR],
    );
    await db.query(`UPDATE "documents"."DocumentTemplate" SET current_version_id = $2 WHERE id = $1`, [id, ver]);
    await db.query(
      `INSERT INTO "documents"."TenantTemplateSelection" (id, tenant_id, document_type_id, client_id, template_id, selected_by, selected_at) VALUES ($1, $2, $3, NULL, $4, $5, now())`,
      [randomUUID(), TENANT, SIGN_TYPE, id, ACTOR],
    );
    const resolution = new TemplateResolutionService(templates);
    expect((await resolution.resolve({ tenant_id: TENANT, document_type_id: SIGN_TYPE, product: 'sign' })).outcome).toBe('RESOLVED');
    // Not tagged ats: skipped; a live default tagged only sign is no ATS starting point.
    expect((await resolution.resolve({ tenant_id: TENANT, document_type_id: SIGN_TYPE, product: 'ats' })).outcome).toBe('NOT_CONFIGURED');
    expect((await resolution.resolve({ tenant_id: TENANT, document_type_id: SIGN_TYPE })).outcome).toBe('RESOLVED');
    expect((await templates.listUsableTemplatesForTenant(TENANT, SIGN_TYPE, null, new Date(), 'ats')).map((t) => t.id)).toEqual([]);
    expect((await templates.listUsableTemplatesForTenant(TENANT, SIGN_TYPE, null, new Date(), 'sign')).map((t) => t.id)).toContain(id);
  });
});
