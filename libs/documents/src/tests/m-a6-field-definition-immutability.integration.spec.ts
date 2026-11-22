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

  // FIELD-PARITY-1 P1-3 — the Sign field settings columns (migration
  // 20261122100000_field_parity_1_template_field_settings): written with a DRAFT's fields, held to
  // Sign's type-scoped CHECKs, and frozen with the version by the same trigger.
  it('FIELD-PARITY-1 P1-3 — settings are stored on a DRAFT, refused by the CHECKs off-type, and frozen once ACTIVE', async () => {
    const { versionId } = await draft();
    const sig = await addField(versionId, 'sig_a', 1);
    const name = await templates.addField({
      tenant_id: TENANT, template_version_id: versionId, field_key: 'name_a', field_type: 'SIGNER_NAME', required: true,
      page_number: 0, x: 10, y: 60, width: 100, height: 20, signer_role: 'client', ordinal: 2, name_mode: 'SIGNER_ENTERED',
    });
    const box = await templates.addField({
      tenant_id: TENANT, template_version_id: versionId, field_key: 'box_a', field_type: 'CHECKBOX', required: false,
      page_number: 0, x: 10, y: 90, width: 18, height: 18, signer_role: 'client', ordinal: 3,
      label: 'Agree', group_key: 'g', group_rule: 'SELECT_ONE', min_selected: 1,
    });
    expect(name).toMatchObject({ name_mode: 'SIGNER_ENTERED', label: null });
    expect(box).toMatchObject({ label: 'Agree', group_key: 'g', group_rule: 'SELECT_ONE', min_selected: 1, name_mode: null });
    expect(sig).toMatchObject({ label: null, group_key: null, group_rule: null, min_selected: null, name_mode: null });

    // The type-scoped CHECKs (the same as Sign's SignatureField).
    const set = (sql: string, id: string): Promise<string> => refused(`UPDATE "documents"."TemplateFieldDefinition" SET ${sql} WHERE id = $1`, [id]);
    // FIELD-PARITY-1 P3 S-1 — a label on any type now; an empty one is still refused.
    expect(await set(`label = ''`, sig.id)).toContain('TemplateFieldDefinition_label_check');
    expect(await set(`name_mode = 'SIGNER_ENTERED'`, sig.id)).toContain('TemplateFieldDefinition_name_mode_check');
    expect(await set(`name_mode = 'TYPED'`, name.id)).toContain('TemplateFieldDefinition_name_mode_check');
    expect(await set(`group_rule = NULL`, box.id)).toContain('TemplateFieldDefinition_group_rule_check');
    expect(await set(`min_selected = 2`, box.id)).toContain('TemplateFieldDefinition_min_selected_check');
    expect(await set(`label = ''`, box.id)).toContain('TemplateFieldDefinition_label_check');

    // Published: the same trigger freezes the settings with the field.
    await templates.recordPreview({ tenant_id: TENANT, version_id: versionId });
    await templates.activateVersion({ tenant_id: TENANT, version_id: versionId, actor_id: ACTOR });
    expect(await set(`label = 'Changed'`, box.id)).toContain('TemplateFieldDefinition is immutable');
    expect(await set(`name_mode = 'SIGNER_PROFILE'`, name.id)).toContain('TemplateFieldDefinition is immutable');
    const kept = await db.query(`SELECT label, name_mode FROM "documents"."TemplateFieldDefinition" WHERE id IN ($1, $2) ORDER BY ordinal`, [name.id, box.id]);
    expect(kept.rows).toEqual([{ label: null, name_mode: 'SIGNER_ENTERED' }, { label: 'Agree', name_mode: null }]);
  });

  it('FIELD-PARITY-1 P1-3 — the settings migration re-runs cleanly (idempotent)', async () => {
    const sql = readFileSync(resolve(ROOT, 'libs/documents/prisma/migrations/20261122100000_field_parity_1_template_field_settings/migration.sql'), 'utf8');
    await db.query(sql);
    await db.query(sql);
    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'documents' AND table_name = 'TemplateFieldDefinition' AND column_name IN ('label','group_key','group_rule','min_selected','name_mode') ORDER BY column_name`,
    );
    expect(cols.rows.map((r: { column_name: string }) => r.column_name)).toEqual(['group_key', 'group_rule', 'label', 'min_selected', 'name_mode']);
  });

  // FIELD-PARITY-1 P3 (migration 20261122200000_field_parity_1_p3_template_field_types_settings) —
  // the new types and settings: stored on a DRAFT, held by the CHECKs, frozen once ACTIVE by the
  // same trigger (the migration fires no row trigger and changes no row).
  it('FIELD-PARITY-1 P3 — new types and settings are stored on a DRAFT, refused by the CHECKs off-type, and frozen once ACTIVE', async () => {
    const { versionId } = await draft();
    await addField(versionId, 'sig_p3', 1);
    const add = (field_key: string, field_type: string, ordinal: number, over: Record<string, unknown> = {}) =>
      templates.addField({ tenant_id: TENANT, template_version_id: versionId, field_key, field_type, required: false, page_number: 0, x: 10, y: 10 + ordinal * 30, width: 120, height: 20, signer_role: 'client', ordinal, ...over });
    const dd = await add('city', 'DROPDOWN', 2, { options: { choices: [{ value: 'ny', label: 'New York' }] }, placeholder: 'Pick', tooltip: 'Where', data_name: 'city' });
    const num = await add('fee', 'NUMBER', 3, { validation: 'number_range', options: { min: 1, format: 'money', currency: 'USD', decimals: 2 }, font_size: 9 });
    const radio = await add('yes', 'RADIO', 4, { label: 'Yes', group_key: 'vote', group_rule: 'SELECT_ONE' });
    await add('ack', 'ACKNOWLEDGEMENT', 5, { label: 'I have read it' });
    await add('title', 'TITLE', 6);
    expect(dd).toMatchObject({ options: { choices: [{ value: 'ny', label: 'New York' }] }, placeholder: 'Pick', tooltip: 'Where', data_name: 'city', read_only: false, sender_filled: false });
    expect(num).toMatchObject({ validation: 'number_range', font_size: 9 });
    expect(radio).toMatchObject({ group_rule: 'SELECT_ONE', min_selected: null });

    const set = (sql: string, id: string): Promise<string> => refused(`UPDATE "documents"."TemplateFieldDefinition" SET ${sql} WHERE id = $1`, [id]);
    expect(await set(`options = NULL`, dd.id)).toContain('TemplateFieldDefinition_dropdown_choices_check');
    expect(await set(`group_rule = 'SELECT_ANY'`, radio.id)).toContain('TemplateFieldDefinition_radio_group_check');
    expect(await set(`validation = 'email'`, num.id)).toContain('TemplateFieldDefinition_validation_check');
    expect(await set(`font_size = 99`, num.id)).toContain('TemplateFieldDefinition_font_size_check');
    expect(await set(`data_name = 'Bad Name'`, dd.id)).toContain('TemplateFieldDefinition_data_name_check');
    expect(await set(`read_only = true`, dd.id)).toContain('TemplateFieldDefinition_read_only_check');
    expect(await set(`options = '[1]'::jsonb`, num.id)).toContain('TemplateFieldDefinition_options_check');
    expect(await set(`tooltip = ''`, dd.id)).toContain('TemplateFieldDefinition_tooltip_check');
    expect(await refused(
      `INSERT INTO "documents"."TemplateFieldDefinition" (id, template_version_id, field_key, field_type, required, ordinal, sender_filled) VALUES ($1, $2, 'sf', 'SIGNATURE', true, 9, true)`,
      [randomUUID(), versionId],
    )).toContain('TemplateFieldDefinition_sender_filled_check');
    expect(await refused(
      `INSERT INTO "documents"."TemplateFieldDefinition" (id, template_version_id, field_key, field_type, required, ordinal) VALUES ($1, $2, 'bad', 'PAYMENT', true, 9)`,
      [randomUUID(), versionId],
    )).toContain('TemplateFieldDefinition_type_check');

    await templates.recordPreview({ tenant_id: TENANT, version_id: versionId });
    await templates.activateVersion({ tenant_id: TENANT, version_id: versionId, actor_id: ACTOR });
    expect(await set(`tooltip = 'Changed'`, dd.id)).toContain('TemplateFieldDefinition is immutable');
    expect(await set(`options = '{"choices":[{"value":"la","label":"LA"}]}'::jsonb`, dd.id)).toContain('TemplateFieldDefinition is immutable');
  });

  it('FIELD-PARITY-1 P3 — the new-settings migration re-runs cleanly and leaves existing rows NULL / false', async () => {
    const sql = readFileSync(resolve(ROOT, 'libs/documents/prisma/migrations/20261122200000_field_parity_1_p3_template_field_types_settings/migration.sql'), 'utf8');
    await db.query(sql);
    await db.query(sql);
    const stale = await db.query(`SELECT count(*)::int AS n FROM "documents"."TemplateFieldDefinition" WHERE field_type = 'SIGNATURE' AND (read_only OR sender_filled OR options IS NOT NULL OR tooltip IS NOT NULL)`);
    expect(stale.rows[0]).toEqual({ n: 0 });
  });
});
