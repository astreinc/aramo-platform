import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService, TemplateImmutableError, TemplatePreviewRequiredError, TemplatesRepository } from '../index.js';

// Amendment M-A6 (LOCKED) §3.4 — on real Postgres 17. Skipped unless ARAMO_RUN_INTEGRATION=1.
//
//   TRIGGER — 20261028110000_doc_template_field_definition_immutability refuses INSERT,
//             UPDATE and DELETE of a TemplateFieldDefinition unless its TemplateVersion is
//             DRAFT (raw SQL, bypassing every app guard); discarding a DRAFT version (with its
//             fields) still works.
//   FINGERPRINT — field definitions join the preview fingerprint: adding one re-arms the
//             preview gate; a version without fields keeps the field_schema-only hash.

const ROOT = resolve(__dirname, '../../../..');

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('M-A6 §3.4 — TemplateFieldDefinition immutability + fingerprint — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let templates: TemplatesRepository;
  const TENANT = randomUUID();
  const ACTOR = randomUUID();
  let typeId = '';

  async function draft(fieldSchema: unknown = { blocks: [{ type: 'TEXT', text: 'Body' }] }): Promise<{ templateId: string; versionId: string }> {
    const t = await templates.createTemplate({ tenant_id: TENANT, document_type_id: typeId, name: 'Form', template_kind: 'UPLOADED_PDF', created_by: ACTOR });
    const v = await templates.createVersion({ tenant_id: TENANT, template_id: t.id, render_schema_version: 'v1', field_schema: fieldSchema, created_by: ACTOR });
    return { templateId: t.id, versionId: v.id };
  }
  const addField = (versionId: string, key: string, ordinal: number, signer_role = 'client') =>
    templates.addField({ tenant_id: TENANT, template_version_id: versionId, field_key: key, field_type: 'SIGNATURE', required: true, page_number: 0, x: 10, y: 10, width: 100, height: 30, signer_role, ordinal });
  async function refused(sql: string, params: unknown[]): Promise<string> {
    try {
      await db.query(sql, params);
      return 'NO_ERROR';
    } catch (e) {
      return (e as { message: string }).message;
    }
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
    typeId = randomUUID();
    await db.query(
      `INSERT INTO "documents"."DocumentType" (id, tenant_id, key, name, scope, execution_mode_default, retention_class)
       VALUES ($1, NULL, 'M_A6_FORM', 'Form', 'SYSTEM', 'MULTI_SIGNATURE', 'CONTRACT_RECORD')`,
      [typeId],
    );
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  it('a DRAFT version accepts field insert / update / delete', async () => {
    const { versionId } = await draft();
    const f = await addField(versionId, 'sig_a', 1);
    await db.query(`UPDATE "documents"."TemplateFieldDefinition" SET x = 20 WHERE id = $1`, [f.id]);
    await db.query(`DELETE FROM "documents"."TemplateFieldDefinition" WHERE id = $1`, [f.id]);
    const n = await db.query(`SELECT count(*)::int AS n FROM "documents"."TemplateFieldDefinition" WHERE template_version_id = $1`, [versionId]);
    expect(n.rows[0].n).toBe(0);
  });

  it('once ACTIVE (and RETIRED) the trigger refuses insert, update and delete — even through raw SQL', async () => {
    const { templateId, versionId } = await draft();
    const f = await addField(versionId, 'sig_a', 1);
    await templates.recordPreview({ tenant_id: TENANT, version_id: versionId });
    await templates.activateVersion({ tenant_id: TENANT, version_id: versionId, actor_id: ACTOR });

    const insert = await refused(
      `INSERT INTO "documents"."TemplateFieldDefinition" (id, template_version_id, field_key, field_type, required, ordinal) VALUES ($1, $2, 'late', 'TEXT', false, 9)`,
      [randomUUID(), versionId],
    );
    expect(insert).toContain('TemplateFieldDefinition is immutable');
    expect(await refused(`UPDATE "documents"."TemplateFieldDefinition" SET x = 99 WHERE id = $1`, [f.id])).toContain('TemplateFieldDefinition is immutable');
    expect(await refused(`UPDATE "documents"."TemplateFieldDefinition" SET signer_role = 'agency' WHERE id = $1`, [f.id])).toContain('TemplateFieldDefinition is immutable');
    expect(await refused(`DELETE FROM "documents"."TemplateFieldDefinition" WHERE id = $1`, [f.id])).toContain('TemplateFieldDefinition is immutable');
    // The app guard refuses first, with the typed error.
    await expect(addField(versionId, 'sig_b', 2)).rejects.toBeInstanceOf(TemplateImmutableError);

    // A field can never be moved INTO a frozen version from a draft either.
    const other = await templates.createDraftFromActive({ tenant_id: TENANT, template_id: templateId, created_by: ACTOR });
    const moving = await addField(other.id, 'sig_m', 1);
    expect(await refused(`UPDATE "documents"."TemplateFieldDefinition" SET template_version_id = $2 WHERE id = $1`, [moving.id, versionId])).toContain(
      'TemplateFieldDefinition is immutable',
    );

    // RETIRED: activating the next version retires this one; still frozen.
    await templates.recordPreview({ tenant_id: TENANT, version_id: other.id });
    await templates.activateVersion({ tenant_id: TENANT, version_id: other.id, actor_id: ACTOR });
    const status = await db.query(`SELECT status FROM "documents"."TemplateVersion" WHERE id = $1`, [versionId]);
    expect(status.rows[0].status).toBe('RETIRED');
    expect(await refused(`DELETE FROM "documents"."TemplateFieldDefinition" WHERE id = $1`, [f.id])).toContain('TemplateFieldDefinition is immutable');
    const kept = await db.query(`SELECT x FROM "documents"."TemplateFieldDefinition" WHERE id = $1`, [f.id]);
    expect(kept.rows[0].x).toBe(10);
  });

  it('discarding a DRAFT version with fields still works (its fields go with it)', async () => {
    const { versionId } = await draft();
    await addField(versionId, 'sig_a', 1);
    await addField(versionId, 'sig_b', 2, 'agency');
    await templates.deleteDraftVersion({ tenant_id: TENANT, version_id: versionId });
    const n = await db.query(`SELECT count(*)::int AS n FROM "documents"."TemplateFieldDefinition" WHERE template_version_id = $1`, [versionId]);
    expect(n.rows[0].n).toBe(0);
  });

  it('fingerprint — a version without fields keeps the field_schema-only hash; adding a field changes it and re-arms the preview gate', async () => {
    const schema = { blocks: [{ type: 'TEXT', text: 'Fingerprint body' }] };
    const { versionId } = await draft(schema);
    const fresh = await db.query(`SELECT content_fingerprint FROM "documents"."TemplateVersion" WHERE id = $1`, [versionId]);
    expect(fresh.rows[0].content_fingerprint).toBe(createHash('sha256').update(stableStringify(schema)).digest('hex'));

    await templates.recordPreview({ tenant_id: TENANT, version_id: versionId });
    await addField(versionId, 'sig_a', 1);
    const after = await db.query(`SELECT content_fingerprint, previewed_fingerprint FROM "documents"."TemplateVersion" WHERE id = $1`, [versionId]);
    expect(after.rows[0].content_fingerprint).not.toBe(fresh.rows[0].content_fingerprint);
    expect(after.rows[0].previewed_fingerprint).toBeNull();
    // Activation refuses until the CURRENT content (with its fields) is previewed.
    await expect(templates.activateVersion({ tenant_id: TENANT, version_id: versionId, actor_id: ACTOR })).rejects.toBeInstanceOf(TemplatePreviewRequiredError);
    await templates.recordPreview({ tenant_id: TENANT, version_id: versionId });
    const active = await templates.activateVersion({ tenant_id: TENANT, version_id: versionId, actor_id: ACTOR });
    expect(active.status).toBe('ACTIVE');
  });

  it('fingerprint — a field written behind the app (raw SQL on a DRAFT) is still caught by the live check at activation', async () => {
    const { versionId } = await draft();
    await templates.recordPreview({ tenant_id: TENANT, version_id: versionId });
    await db.query(
      `INSERT INTO "documents"."TemplateFieldDefinition" (id, template_version_id, field_key, field_type, required, ordinal, signer_role) VALUES ($1, $2, 'raw', 'SIGNATURE', true, 1, 'client')`,
      [randomUUID(), versionId],
    );
    await expect(templates.activateVersion({ tenant_id: TENANT, version_id: versionId, actor_id: ACTOR })).rejects.toBeInstanceOf(TemplatePreviewRequiredError);
  });
});
