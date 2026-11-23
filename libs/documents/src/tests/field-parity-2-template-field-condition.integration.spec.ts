import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService, TemplatesRepository } from '../index.js';

// FIELD-PARITY-2 (Aramo-Sign-Field-Placement-Conditional-Fields-Directive-v1_0-LOCKED) §4.2 B-2,
// §5 test 3 — documents TemplateFieldDefinition.condition on real Postgres 17 (migration
// 20261123100100_field_parity_2_template_field_condition). Skipped unless ARAMO_RUN_INTEGRATION=1.
//   - the shape CHECK (the same as the Sign field table's);
//   - addField stores the condition; it joins the preview fingerprint (re-arms the gate) and is
//     frozen once ACTIVE by the existing immutability trigger;
//   - the migration re-runs cleanly and leaves existing rows NULL.
// JSONB values go to node-pg as JSON text (JSON.stringify).

const ROOT = resolve(__dirname, '../../../..');

function documentsMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/documents/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('FIELD-PARITY-2 B-2 — TemplateFieldDefinition.condition — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let templates: TemplatesRepository;
  const TENANT = randomUUID();
  const ACTOR = randomUUID();
  let typeId = '';

  async function draft(): Promise<string> {
    const t = await templates.createTemplate({ tenant_id: TENANT, document_type_id: typeId, name: 'Form', template_kind: 'UPLOADED_PDF', created_by: ACTOR });
    const v = await templates.createVersion({ tenant_id: TENANT, template_id: t.id, render_schema_version: 'v1', field_schema: { blocks: [{ type: 'TEXT', text: 'Body' }] }, created_by: ACTOR });
    return v.id;
  }
  const add = (versionId: string, field_key: string, field_type: string, ordinal: number, over: Record<string, unknown> = {}) =>
    templates.addField({ tenant_id: TENANT, template_version_id: versionId, field_key, field_type, required: false, page_number: 0, x: 10, y: 10 + ordinal * 30, width: 120, height: 20, signer_role: 'client', ordinal, ...over });
  const fingerprint = async (versionId: string): Promise<string> =>
    (await db.query(`SELECT content_fingerprint FROM "documents"."TemplateVersion" WHERE id = $1`, [versionId])).rows[0].content_fingerprint as string;
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
       VALUES ($1, NULL, 'FP2_FORM', 'Form', 'SYSTEM', 'MULTI_SIGNATURE', 'CONTRACT_RECORD')`,
      [typeId],
    );
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  it('the shape CHECK refuses broken conditions and accepts each rule', async () => {
    const versionId = await draft();
    const insert = (key: string, condition: unknown) =>
      refused(`INSERT INTO "documents"."TemplateFieldDefinition" (id, template_version_id, field_key, field_type, required, ordinal, condition) VALUES ($1, $2, $3, 'TEXT', false, 1, $4::jsonb)`, [
        randomUUID(),
        versionId,
        key,
        JSON.stringify(condition),
      ]);
    for (const [i, bad] of ([['checked'], { when: 'checked' }, { trigger_key: 't', when: 'is' }, { trigger_key: 't', when: 'checked', values: ['a'] }, { trigger_key: 't', when: 'one_of', values: [] }, { trigger_key: 't', when: 'one_of', values: [2] }] as unknown[]).entries()) {
      expect(await insert(`bad_${i}`, bad)).toContain('TemplateFieldDefinition_condition_check');
    }
    for (const [i, ok] of ([{ trigger_key: 't', when: 'checked' }, { trigger_key: 't', when: 'one_of', values: ['a'] }] as unknown[]).entries()) {
      expect(await insert(`ok_${i}`, ok)).toBe('NO_ERROR');
    }
  });

  it('addField stores the condition; it joins the fingerprint and is frozen once ACTIVE', async () => {
    const versionId = await draft();
    await add(versionId, 'sig', 'SIGNATURE', 1, { required: true });
    await add(versionId, 'agree', 'CHECKBOX', 2);
    const before = await fingerprint(versionId);
    const detail = await add(versionId, 'detail', 'TEXT', 3, { condition: { trigger_key: 'agree', when: 'checked' } });
    expect(detail).toMatchObject({ field_key: 'detail', condition: { trigger_key: 'agree', when: 'checked' } });
    expect(await fingerprint(versionId)).not.toBe(before);
    await templates.recordPreview({ tenant_id: TENANT, version_id: versionId });
    await templates.activateVersion({ tenant_id: TENANT, version_id: versionId, actor_id: ACTOR });
    expect(await refused(`UPDATE "documents"."TemplateFieldDefinition" SET condition = NULL WHERE id = $1`, [detail.id])).toContain('TemplateFieldDefinition is immutable');
  });

  it('the migration re-runs cleanly and leaves existing rows NULL', async () => {
    const sql = readFileSync(resolve(ROOT, 'libs/documents/prisma/migrations/20261123100100_field_parity_2_template_field_condition/migration.sql'), 'utf8');
    await db.query(sql);
    await db.query(sql);
    const stale = await db.query(`SELECT count(*)::int AS n FROM "documents"."TemplateFieldDefinition" WHERE field_type = 'SIGNATURE' AND condition IS NOT NULL`);
    expect(stale.rows[0]).toEqual({ n: 0 });
  });
});
