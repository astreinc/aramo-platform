import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EsignSenderRepository, PrismaService, SENDER_FIELD_VALUES_SET_EVENT } from '../index.js';
import { EsignRepository } from '../lib/esign.repository.js';
import { EsignService, type SessionContext } from '../lib/esign.service.js';
import { currentDisclosure } from '../lib/domain/disclosure.js';
import { SoftwareEvidenceManifestSigner } from '../lib/ports/evidence-manifest-signer.port.js';
import { SignatureFieldIncompleteError, SignatureFieldValueRefusedError } from '../lib/domain/errors.js';

// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §6 Phase 3,
// on real Postgres 17 with every sign migration (incl. 20261122200000_field_parity_1_p3_field_types_settings).
// Skipped unless ARAMO_RUN_INTEGRATION=1 (CI runs it).
//   - the migration's CHECKs: the new types, RADIO always SELECT_ONE, DROPDOWN choices, the
//     settings' type scoping, read_only only with sender_filled, label on any type;
//   - the signer view carries the settings; fill validates DATE / NUMBER / DROPDOWN /
//     MULTILINE_TEXT and the validation presets; a sender-filled value is refused
//     (field_read_only); choosing a radio button clears its group;
//   - completion: a required radio group needs one choice (radio_group_select_one); a
//     sender-filled field never blocks;
//   - S-5: replaceDraftFields stores the sender's value and records SENDER_FIELD_VALUES_SET
//     (actor = the sender, value SHA-256 only).

const ROOT = resolve(__dirname, '../../../..');
const DISCLOSURE = currentDisclosure();

function esignMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

type FieldSpec = { key: string; field_type: string; required?: boolean; data?: Record<string, unknown> };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('FIELD-PARITY-1 P3 — new types and settings — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let sender: EsignSenderRepository;
  let service: EsignService;
  const TENANT = randomUUID();
  const ACTOR = randomUUID();

  async function signer(fields: FieldSpec[]): Promise<{ ctx: SessionContext; ids: Map<string, string> }> {
    // Two signers (as the M-A6 spec does), so A's completion leaves the envelope IN_PROGRESS.
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'P3', execution_mode: 'MULTI_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({ tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'p3.pdf', source_sha256: 'seed', ordinal: 1 });
    const a = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'alex@x.com', name: 'Alex Rivera', signing_order: 1 });
    const b = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'blake@x.com', name: 'Blake', signing_order: 2 });
    await repo.addField({ tenant_id: TENANT, envelope_document_id: doc.id, signer_id: b.id, field_type: 'SIGNATURE', page_number: 0, x: 300, y: 300, required: true });
    const ids = new Map<string, string>();
    let y = 60;
    for (const f of fields) {
      const row = await repo.addField({ tenant_id: TENANT, envelope_document_id: doc.id, signer_id: a.id, field_type: 'TEXT', page_number: 0, x: 72, y: (y += 30), width: 150, height: 22, required: f.required ?? true });
      await prisma.signatureField.update({ where: { id: row.id }, data: { field_type: f.field_type, ...(f.data ?? {}) } as never });
      ids.set(f.key, row.id);
    }
    const { sessions } = await service.send(TENANT, env.id, ACTOR);
    const ctx = await service.exchangeToken(sessions.find((x) => x.signer_id === a.id)!.raw_token);
    await service.acceptDisclosure(ctx, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256 });
    return { ctx, ids };
  }

  const reasonOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
      await p;
      return undefined;
    } catch (e) {
      if (e instanceof SignatureFieldIncompleteError || e instanceof SignatureFieldValueRefusedError) return e.reason;
      throw e;
    }
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    db = new Client({ connectionString: url });
    await db.connect();
    for (const m of esignMigrations()) await db.query(readFileSync(m, 'utf8'));
    prisma = new PrismaService(url);
    await prisma.$connect();
    repo = new EsignRepository(prisma);
    sender = new EsignSenderRepository(prisma, repo);
    service = new EsignService(prisma, repo, new SoftwareEvidenceManifestSigner());
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  it('the migration CHECKs: new types and settings accepted where they apply, refused elsewhere', async () => {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Checks', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({ tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'c.pdf', source_sha256: 'seed', ordinal: 1 });
    const insert = (field_type: string, cols: string, vals: unknown[]) =>
      db.query(
        `INSERT INTO "sign"."SignatureField" (id, tenant_id, envelope_document_id, field_type, page_number, x, y${cols}) VALUES ($1, $2, $3, $4, 0, 1, 1${vals.map((_, i) => `, $${i + 5}`).join('')})`,
        [randomUUID(), TENANT, doc.id, field_type, ...vals],
      );
    const refused: Array<[string, string, unknown[], string]> = [
      ['STAMP', '', [], 'SignatureField_type_check'],
      ['RADIO', '', [], 'SignatureField_radio_group_check'],
      ['RADIO', ', group_key, group_rule', ['v', 'SELECT_ANY'], 'SignatureField_radio_group_check'],
      ['DROPDOWN', '', [], 'SignatureField_dropdown_choices_check'],
      ['DROPDOWN', ', options', [{ choices: 'a' }], 'SignatureField_dropdown_choices_check'],
      ['TEXT', ', validation', ['date_range'], 'SignatureField_validation_check'],
      ['NUMBER', ', validation', ['email'], 'SignatureField_validation_check'],
      ['TEXT', ', font_size', [5], 'SignatureField_font_size_check'],
      ['TEXT', ', data_name', ['Bad Name'], 'SignatureField_data_name_check'],
      ['TEXT', ', read_only', [true], 'SignatureField_read_only_check'],
      ['SIGNATURE', ', sender_filled', [true], 'SignatureField_sender_filled_check'],
      ['TEXT', ', options', [[1]], 'SignatureField_options_check'],
      ['TEXT', ', tooltip', [''], 'SignatureField_tooltip_check'],
      ['TEXT', ', placeholder', ['x'.repeat(201)], 'SignatureField_placeholder_check'],
      ['TEXT', ', group_key, group_rule', ['g', 'SELECT_ANY'], 'SignatureField_group_key_check'],
    ];
    const outcomes: string[] = [];
    for (const [type, cols, vals] of refused) {
      outcomes.push(await insert(type, cols, vals).then(() => `${type}${cols} accepted`, (e: { constraint?: string }) => e.constraint ?? 'other'));
    }
    expect(outcomes).toEqual(refused.map(([, , , c]) => c));
    // Accepted: the new types with their settings; a label on any type.
    await insert('DATE', ', validation, options, data_name, font_size', ['date_range', { min_date: '2026-01-01' }, 'due', 9]);
    await insert('DROPDOWN', ', options, placeholder', [{ choices: [{ value: 'a', label: 'A' }] }, 'Pick']);
    await insert('RADIO', ', group_key, group_rule, label', ['v', 'SELECT_ONE', 'Yes']);
    await insert('NUMBER', ', sender_filled, read_only, value', [true, true, '12.50']);
    await insert('MULTILINE_TEXT', ', validation, options', ['max_length', { max_length: 300 }]);
    await insert('SIGNATURE', ', label, tooltip', ['Buyer signature', 'Sign here']);
    // Existing rows keep NULL / false in every new column.
    const legacy = await db.query(`SELECT count(*)::int AS n FROM "sign"."SignatureField" WHERE field_type = 'SIGNATURE' AND label IS NULL AND (read_only OR sender_filled OR options IS NOT NULL)`);
    expect(legacy.rows[0]).toEqual({ n: 0 });
  });

  it('the signer view carries the settings; fill validates the new types and presets', async () => {
    const { ctx, ids } = await signer([
      { key: 'date', field_type: 'DATE', data: { validation: 'date_range', options: { min_date: '2026-01-01', max_date: '2026-12-31' }, label: 'Effective' } },
      { key: 'num', field_type: 'NUMBER', data: { options: { format: 'money', currency: 'USD', decimals: 2 } } },
      { key: 'dd', field_type: 'DROPDOWN', data: { options: { choices: [{ value: 'ny', label: 'New York' }] }, placeholder: 'Pick' } },
      { key: 'zip', field_type: 'TEXT', data: { validation: 'us_zip' } },
      { key: 'notes', field_type: 'MULTILINE_TEXT', required: false, data: { validation: 'max_length', options: { max_length: 5 } } },
    ]);
    const view = await service.getSignerDocumentView(ctx);
    const by = new Map(view.fields.map((f) => [f.field_id, f]));
    expect(by.get(ids.get('date')!)).toMatchObject({ field_type: 'DATE', label: 'Effective', validation: 'date_range', options: { min_date: '2026-01-01', max_date: '2026-12-31' }, read_only: false, sender_filled: false });
    expect(by.get(ids.get('dd')!)).toMatchObject({ placeholder: 'Pick', options: { choices: [{ value: 'ny', label: 'New York' }] } });

    expect(await reasonOf(service.fillField(ctx, ids.get('date')!, { value: '2026-02-30' }))).toBe('date_value_invalid');
    expect(await reasonOf(service.fillField(ctx, ids.get('date')!, { value: '2027-01-01' }))).toBe('validation_date_range_failed');
    expect(await reasonOf(service.fillField(ctx, ids.get('num')!, { value: '1.234' }))).toBe('number_decimals_exceeded');
    expect(await reasonOf(service.fillField(ctx, ids.get('dd')!, { value: 'la' }))).toBe('dropdown_value_invalid');
    expect(await reasonOf(service.fillField(ctx, ids.get('zip')!, { value: '0213' }))).toBe('validation_us_zip_failed');
    expect(await reasonOf(service.fillField(ctx, ids.get('notes')!, { value: 'abcdef' }))).toBe('validation_max_length_failed');

    await service.fillField(ctx, ids.get('date')!, { value: '2026-06-01' });
    await service.fillField(ctx, ids.get('num')!, { value: '1250.5' });
    await service.fillField(ctx, ids.get('dd')!, { value: 'ny' });
    await service.fillField(ctx, ids.get('zip')!, { value: '02139' });
    const stored = await prisma.signatureField.findMany({ where: { id: { in: [ids.get('date')!, ids.get('num')!, ids.get('dd')!] } }, orderBy: { y: 'asc' } });
    expect(stored.map((f) => f.value)).toEqual(['2026-06-01', '1250.5', 'ny']);
  });

  it('a sender-filled value is the sender’s: the signer cannot change it, and it never blocks completion', async () => {
    const { ctx, ids } = await signer([
      { key: 'ref', field_type: 'TEXT', data: { sender_filled: true, read_only: true, value: 'PO-7', filled_at: new Date() } },
      { key: 'sig', field_type: 'TEXT' },
    ]);
    expect(await reasonOf(service.fillField(ctx, ids.get('ref')!, { value: 'changed' }))).toBe('field_read_only');
    const view = await service.getSignerDocumentView(ctx);
    expect(view.fields.find((f) => f.field_id === ids.get('ref'))).toMatchObject({ sender_filled: true, read_only: true, value: 'PO-7', filled: true });
    await service.fillField(ctx, ids.get('sig')!, { value: 'typed' });
    await service.completeSigner(ctx);
    expect((await prisma.signatureField.findUniqueOrThrow({ where: { id: ids.get('ref')! } })).value).toBe('PO-7');
  });

  it('a radio group: choosing one clears the others; a required group needs one choice', async () => {
    const radio = (label: string) => ({ group_key: 'vote', group_rule: 'SELECT_ONE', label });
    const { ctx, ids } = await signer([
      { key: 'yes', field_type: 'RADIO', data: radio('Yes') },
      { key: 'no', field_type: 'RADIO', data: radio('No') },
    ]);
    expect(await reasonOf(service.completeSigner(ctx))).toBe('radio_group_select_one');
    await service.fillField(ctx, ids.get('yes')!, { value: 'true' });
    await service.fillField(ctx, ids.get('no')!, { value: 'true' });
    const rows = await prisma.signatureField.findMany({ where: { id: { in: [ids.get('yes')!, ids.get('no')!] } } });
    expect(Object.fromEntries(rows.map((r) => [r.label, r.value]))).toEqual({ Yes: 'false', No: 'true' });
    expect(await reasonOf(service.fillField(ctx, ids.get('yes')!, { value: 'maybe' }))).toBe('checkbox_value_invalid');
    await service.completeSigner(ctx);
  });

  it('S-5 — replaceDraftFields stores the sender’s value and records it in the ledger as the sender’s (hash only)', async () => {
    const d = await sender.createDraft({ tenant_id: TENANT, subject: 'Sender values', created_by: ACTOR });
    const [s1] = await sender.replaceDraftRecipients({ tenant_id: TENANT, envelope_id: d.id, recipients: [{ name: 'Alex', email: 'alex@x.com' }] });
    const doc = await sender.addDraftCoreRefDocument({ tenant_id: TENANT, envelope_id: d.id, actor_ref: ACTOR, title: 'f.pdf', document_ref: randomUUID(), document_revision_ref: randomUUID(), source_sha256: 'seed' });
    const base = { envelope_document_id: doc.id, signer_id: s1!.id, page_number: 0, x: 10, y: 10, width: 120, height: 22, required: true };
    await sender.replaceDraftFields({
      tenant_id: TENANT,
      envelope_id: d.id,
      actor_ref: ACTOR,
      fields: [
        { ...base, field_type: 'NUMBER', sender_filled: true, read_only: true, options: { format: 'money', currency: 'USD', decimals: 2 }, label: 'Fee', sender_value: '99.5' },
        { ...base, y: 60, field_type: 'SIGNATURE' },
      ],
    });
    const rows = await prisma.signatureField.findMany({ where: { envelope_document_id: doc.id }, orderBy: { y: 'asc' } });
    expect(rows[0]).toMatchObject({ field_type: 'NUMBER', sender_filled: true, read_only: true, value: '99.5', label: 'Fee', options: { format: 'money', currency: 'USD', decimals: 2 } });
    expect(rows[0]!.filled_at).not.toBeNull();
    expect(rows[1]).toMatchObject({ field_type: 'SIGNATURE', sender_filled: false, value: null });
    const events = await prisma.signatureEvent.findMany({ where: { tenant_id: TENANT, envelope_id: d.id, event_type: SENDER_FIELD_VALUES_SET_EVENT } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_type: 'SERVICE', actor_ref: ACTOR });
    expect(JSON.stringify(events[0]!.payload)).not.toContain('99.5');
    expect(events[0]!.payload).toMatchObject({ entered_by: 'SENDER', fields: [{ field_id: rows[0]!.id, field_type: 'NUMBER', label: 'Fee' }] });
  });
});
