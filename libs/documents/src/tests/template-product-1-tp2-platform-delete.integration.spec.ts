import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PrismaService,
  TemplateImmutableError,
  TemplateInUseError,
  TemplateNotFoundError,
  TemplatesRepository,
} from '../index.js';

// TEMPLATE-PRODUCT-1 TP-2 (§3.1, §3.2) on real Postgres 17: discarding the DRAFT of an Aramo
// default (DRAFT only, field definitions removed, published version untouched) and deleting
// a never-published Aramo default (every guard: published, selection, documents, adopted;
// delete order field definitions → versions → template; the beforeDelete hook runs last and
// aborts the delete when it throws). Skipped unless ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('TEMPLATE-PRODUCT-1 TP-2 — platform delete — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let templates: TemplatesRepository;
  const ACTOR = randomUUID();

  async function newDocumentType(): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class)
       VALUES ($1, NULL, $2, 'Doc', 'SYSTEM', 'SINGLE_SIGNATURE', 'CONTRACT_RECORD')`,
      [id, `TP2_${id.slice(0, 8)}`],
    );
    return id;
  }

  // A never-published default with an open DRAFT carrying one field definition.
  async function draftDefault(typeId: string): Promise<{ templateId: string; versionId: string }> {
    const t = await templates.createPlatformTemplate({ document_type_id: typeId, name: 'Draft', template_kind: 'GENERATED', products: ['ats'], created_by: ACTOR });
    const v = await templates.createPlatformVersion({ template_id: t.id, render_schema_version: 'v1', field_schema: { blocks: [] }, created_by: ACTOR });
    await db.query(
      `INSERT INTO "documents"."TemplateFieldDefinition" (id, template_version_id, field_key, field_type, ordinal) VALUES ($1, $2, 'sig', 'SIGNATURE', 0)`,
      [randomUUID(), v.id],
    );
    return { templateId: t.id, versionId: v.id };
  }

  const count = async (table: string, col: string, id: string): Promise<number> =>
    Number((await db.query(`SELECT count(*)::int AS n FROM "documents"."${table}" WHERE "${col}" = $1`, [id])).rows[0].n);

  async function reasonsOf(p: Promise<unknown>): Promise<readonly string[]> {
    try {
      await p;
    } catch (e) {
      if (e instanceof TemplateInUseError) return e.reasons;
      throw e;
    }
    throw new Error('expected TemplateInUseError');
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
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  // ── §3.1 discard draft ──────────────────────────────────────────────────────
  it('discards a DRAFT and its field definitions; the hook sees the version first', async () => {
    const { templateId, versionId } = await draftDefault(await newDocumentType());
    const seen: string[] = [];
    await templates.deletePlatformDraftVersion({
      version_id: versionId,
      beforeDelete: async (p) => {
        seen.push(`${p.template.id}:${p.version.version_number}`);
        expect(await count('TemplateVersion', 'id', versionId)).toBe(1);
      },
    });
    expect(seen).toEqual([`${templateId}:1`]);
    expect(await count('TemplateVersion', 'id', versionId)).toBe(0);
    expect(await count('TemplateFieldDefinition', 'template_version_id', versionId)).toBe(0);
    expect(await count('DocumentTemplate', 'id', templateId)).toBe(1);
  });

  it('a published version is never discarded; a failing hook leaves the draft', async () => {
    const { templateId, versionId } = await draftDefault(await newDocumentType());
    await expect(
      templates.deletePlatformDraftVersion({ version_id: versionId, beforeDelete: async () => Promise.reject(new Error('audit down')) }),
    ).rejects.toThrow('audit down');
    expect(await count('TemplateVersion', 'id', versionId)).toBe(1);
    await templates.recordPlatformPreview(versionId);
    await templates.activatePlatformVersion({ version_id: versionId, actor_id: ACTOR });
    await expect(templates.deletePlatformDraftVersion({ version_id: versionId })).rejects.toBeInstanceOf(TemplateImmutableError);
    expect((await templates.getPlatformTemplate(templateId)).current_version_id).toBe(versionId);
  });

  it('a tenant version is not reachable through the platform discard', async () => {
    const typeId = await newDocumentType();
    const own = await templates.createTemplate({ tenant_id: randomUUID(), document_type_id: typeId, name: 'Own', template_kind: 'GENERATED', created_by: ACTOR });
    const v = await templates.createVersion({ tenant_id: own.tenant_id as string, template_id: own.id, render_schema_version: 'v1', created_by: ACTOR });
    await expect(templates.deletePlatformDraftVersion({ version_id: v.id })).rejects.toThrow(/not found/);
    await expect(templates.deletePlatformTemplate({ id: own.id })).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  // ── §3.2 delete never-published template ─────────────────────────────────────
  it('deletes a never-published default: field definitions → versions → template', async () => {
    const { templateId, versionId } = await draftDefault(await newDocumentType());
    await templates.deletePlatformTemplate({ id: templateId });
    expect(await count('DocumentTemplate', 'id', templateId)).toBe(0);
    expect(await count('TemplateVersion', 'template_id', templateId)).toBe(0);
    expect(await count('TemplateFieldDefinition', 'template_version_id', versionId)).toBe(0);
    await expect(templates.deletePlatformTemplate({ id: templateId })).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  it('refuses a published default (also after withdrawal) and keeps every row', async () => {
    const { templateId, versionId } = await draftDefault(await newDocumentType());
    await templates.recordPlatformPreview(versionId);
    await templates.activatePlatformVersion({ version_id: versionId, actor_id: ACTOR });
    expect(await reasonsOf(templates.deletePlatformTemplate({ id: templateId }))).toEqual(['published']);
    await templates.withdrawPlatformTemplate({ id: templateId, notice_days: 0 });
    expect(await reasonsOf(templates.deletePlatformTemplate({ id: templateId }))).toEqual(['published']);
    expect(await count('TemplateVersion', 'template_id', templateId)).toBe(1);
  });

  it('refuses while a selection, a pinned Document / revision or an adopted copy references it', async () => {
    const typeId = await newDocumentType();
    const { templateId, versionId } = await draftDefault(typeId);
    const tenant = randomUUID();
    // Raw rows: the conditions are reachable only by data the app never writes for a
    // DRAFT default, so the explicit checks are exercised directly.
    await db.query(
      `INSERT INTO "documents"."TenantTemplateSelection" (id, tenant_id, document_type_id, client_id, template_id, selected_by, updated_at)
       VALUES ($1,$2,$3,NULL,$4,$5,now())`,
      [randomUUID(), tenant, typeId, templateId, ACTOR],
    );
    const docId = randomUUID();
    await db.query(
      `INSERT INTO "documents"."Document" (id, tenant_id, document_type_id, template_version_id, title, status, execution_mode, source_kind, created_by)
       VALUES ($1,$2,$3,$4,'Doc','DRAFT','SINGLE_SIGNATURE','TEMPLATE_GENERATED',$5)`,
      [docId, tenant, typeId, versionId, ACTOR],
    );
    await db.query(
      `INSERT INTO "documents"."DocumentTemplate" (id, owner_scope, tenant_id, document_type_id, name, template_kind, status, created_by, adopted_from_template_id)
       VALUES ($1,'TENANT',$2,$3,'Copy','GENERATED','DRAFT',$4,$5)`,
      [randomUUID(), tenant, typeId, ACTOR, templateId],
    );
    expect(await reasonsOf(templates.deletePlatformTemplate({ id: templateId }))).toEqual(['selection', 'documents', 'adopted']);
    expect(await count('DocumentTemplate', 'id', templateId)).toBe(1);
    expect(await count('TemplateFieldDefinition', 'template_version_id', versionId)).toBe(1);
  });

  it('the hook runs after every check; a failing hook rolls the delete back', async () => {
    const { templateId } = await draftDefault(await newDocumentType());
    await expect(
      templates.deletePlatformTemplate({ id: templateId, beforeDelete: async () => Promise.reject(new Error('audit down')) }),
    ).rejects.toThrow('audit down');
    expect(await count('DocumentTemplate', 'id', templateId)).toBe(1);
    expect(await count('TemplateVersion', 'template_id', templateId)).toBe(1);
  });
});
