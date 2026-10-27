import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../index.js';
import { EsignRepository } from '../lib/esign.repository.js';
import { EsignService, type SessionContext } from '../lib/esign.service.js';
import { currentDisclosure } from '../lib/domain/disclosure.js';
import { SoftwareEvidenceManifestSigner } from '../lib/ports/evidence-manifest-signer.port.js';
import { SignatureFieldIncompleteError, SignatureFieldValueRefusedError } from '../lib/domain/errors.js';

// M-A6 §2 — Name and Checkbox fields on the signer path, against real Postgres 17
// with every sign migration (incl. 20261028100200_sign_field_name_checkbox_config):
//   - the signer view carries the field configuration and the server-filled name,
//     and never another signer's fields or values;
//   - a SIGNER_PROFILE name is refused from the client and filled by the server
//     at completion (Signer.name, or the HOSTED attested name when the port answers);
//   - check boxes take 'true'/'false' (unchecking allowed);
//   - completion enforces required boxes, SELECT_ONE and min_selected;
//   - the migration's type-scoped CHECKs hold.

const ROOT = resolve(__dirname, '../../../..');
const DISCLOSURE = currentDisclosure();

function esignMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

type FieldSpec = {
  key: string;
  field_type: string;
  required?: boolean;
  label?: string;
  group_key?: string;
  group_rule?: string;
  min_selected?: number;
  name_mode?: string;
};

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('M-A6 §2 Name and Checkbox signer rules — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let service: EsignService;

  const TENANT = randomUUID();
  const ACTOR = randomUUID();

  // One sent envelope: signer A (Alex Rivera) holds `fields`; signer B (Blake)
  // holds one filled TEXT field A must never see. Returns A's accepted session.
  async function signerA(fields: FieldSpec[], svc: EsignService = service): Promise<{ ctx: SessionContext; ids: Map<string, string>; envelopeId: string; signerId: string }> {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Boxes', execution_mode: 'MULTI_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({
      tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(),
      title: 'form.pdf', source_sha256: 'seed', ordinal: 1,
    });
    const a = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'alex@x.com', name: 'Alex Rivera', signing_order: 1 });
    const b = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'blake@x.com', name: 'Blake', signing_order: 2 });
    const ids = new Map<string, string>();
    let y = 60;
    for (const f of fields) {
      const row = await repo.addField({ tenant_id: TENANT, envelope_document_id: doc.id, signer_id: a.id, field_type: f.field_type, page_number: 0, x: 72, y: (y += 30), width: 14, height: 14, required: f.required ?? true });
      await prisma.signatureField.update({
        where: { id: row.id },
        data: { label: f.label ?? null, group_key: f.group_key ?? null, group_rule: f.group_rule ?? null, min_selected: f.min_selected ?? null, name_mode: f.name_mode ?? null },
      });
      ids.set(f.key, row.id);
    }
    const other = await repo.addField({ tenant_id: TENANT, envelope_document_id: doc.id, signer_id: b.id, field_type: 'TEXT', page_number: 0, x: 300, y: 300, required: true });
    await prisma.signatureField.update({ where: { id: other.id }, data: { value: 'Blake secret', filled_at: new Date() } });
    const { sessions } = await svc.send(TENANT, env.id, ACTOR);
    const raw = sessions.find((s) => s.signer_id === a.id)!.raw_token;
    const ctx = await svc.exchangeToken(raw);
    await svc.acceptDisclosure(ctx, { disclosure_version: DISCLOSURE.version, disclosure_text_hash: DISCLOSURE.text_sha256 });
    return { ctx, ids, envelopeId: env.id, signerId: a.id };
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
    service = new EsignService(prisma, repo, new SoftwareEvidenceManifestSigner());
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  it('the signer view carries the configuration and the server-filled name, never another signer’s field', async () => {
    const { ctx, ids } = await signerA([
      { key: 'name', field_type: 'SIGNER_NAME', name_mode: 'SIGNER_PROFILE' },
      { key: 'typed', field_type: 'SIGNER_NAME', name_mode: 'SIGNER_ENTERED' },
      { key: 'box', field_type: 'CHECKBOX', label: 'I agree', required: false },
      { key: 'g1', field_type: 'CHECKBOX', group_key: 'plan', group_rule: 'SELECT_ONE' },
    ]);
    const view = await service.getSignerDocumentView(ctx);
    expect(view.fields).toHaveLength(4);
    const by = new Map(view.fields.map((f) => [f.field_id, f]));
    expect(by.get(ids.get('name')!)).toMatchObject({ name_mode: 'SIGNER_PROFILE', server_filled: true, filled: true, value: 'Alex Rivera' });
    expect(by.get(ids.get('typed')!)).toMatchObject({ name_mode: 'SIGNER_ENTERED', server_filled: false, filled: false, value: null });
    expect(by.get(ids.get('box')!)).toMatchObject({ label: 'I agree', group_key: null, group_rule: null, min_selected: null, name_mode: null, required: false });
    expect(by.get(ids.get('g1')!)).toMatchObject({ group_key: 'plan', group_rule: 'SELECT_ONE' });
    expect(JSON.stringify(view)).not.toContain('Blake');
    expect(JSON.stringify(view)).not.toContain(TENANT);
  });

  it('refuses a client value for a SIGNER_PROFILE name and a non-boolean check box value; unchecking is allowed', async () => {
    const { ctx, ids } = await signerA([
      { key: 'name', field_type: 'SIGNER_NAME', name_mode: 'SIGNER_PROFILE' },
      { key: 'box', field_type: 'CHECKBOX' },
    ]);
    expect(await reasonOf(service.fillField(ctx, ids.get('name')!, { value: 'Mallory' }))).toBe('signer_profile_name_server_filled');
    expect(await reasonOf(service.fillField(ctx, ids.get('box')!, { value: 'yes' }))).toBe('checkbox_value_invalid');
    expect(await reasonOf(service.fillField(ctx, ids.get('box')!, { value: 'true' }))).toBeUndefined();
    expect(await reasonOf(service.fillField(ctx, ids.get('box')!, { value: 'false' }))).toBeUndefined();
    const row = await prisma.signatureField.findUniqueOrThrow({ where: { id: ids.get('box')! } });
    expect(row.value).toBe('false');
    expect(row.filled_at).not.toBeNull();
    const name = await prisma.signatureField.findUniqueOrThrow({ where: { id: ids.get('name')! } });
    expect(name.value).toBeNull();
  });

  it('a required check box must be checked at completion', async () => {
    const { ctx, ids } = await signerA([{ key: 'box', field_type: 'CHECKBOX' }]);
    await service.fillField(ctx, ids.get('box')!, { value: 'false' });
    expect(await reasonOf(service.completeSigner(ctx))).toBe('checkbox_required_unchecked');
    await service.fillField(ctx, ids.get('box')!, { value: 'true' });
    await expect(service.completeSigner(ctx)).resolves.toMatchObject({ envelope_status: 'IN_PROGRESS' });
  });

  it('SELECT_ONE needs exactly one box checked in a required group', async () => {
    const g = { field_type: 'CHECKBOX', group_key: 'plan', group_rule: 'SELECT_ONE' };
    const { ctx, ids } = await signerA([{ key: 'a', ...g }, { key: 'b', ...g }, { key: 'c', ...g }]);
    expect(await reasonOf(service.completeSigner(ctx))).toBe('checkbox_group_select_one');
    await service.fillField(ctx, ids.get('a')!, { value: 'true' });
    await service.fillField(ctx, ids.get('b')!, { value: 'true' });
    expect(await reasonOf(service.completeSigner(ctx))).toBe('checkbox_group_select_one');
    await service.fillField(ctx, ids.get('b')!, { value: 'false' });
    await expect(service.completeSigner(ctx)).resolves.toMatchObject({ envelope_status: 'IN_PROGRESS' });
  });

  it('a required SELECT_ANY group needs min_selected boxes checked', async () => {
    const g = { field_type: 'CHECKBOX', group_key: 'topics', group_rule: 'SELECT_ANY', min_selected: 2 };
    const { ctx, ids } = await signerA([{ key: 'a', ...g }, { key: 'b', ...g }, { key: 'c', ...g }]);
    await service.fillField(ctx, ids.get('a')!, { value: 'true' });
    let caught: unknown;
    try {
      await service.completeSigner(ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SignatureFieldIncompleteError);
    expect(caught).toMatchObject({ reason: 'checkbox_group_min_selected', group_key: 'topics' });
    await service.fillField(ctx, ids.get('c')!, { value: 'true' });
    await expect(service.completeSigner(ctx)).resolves.toMatchObject({ envelope_status: 'IN_PROGRESS' });
  });

  it('the server fills a SIGNER_PROFILE name from Signer.name at completion; a SIGNER_ENTERED name is the signer’s', async () => {
    const { ctx, ids } = await signerA([
      { key: 'name', field_type: 'SIGNER_NAME', name_mode: 'SIGNER_PROFILE' },
      { key: 'typed', field_type: 'SIGNER_NAME', name_mode: 'SIGNER_ENTERED' },
    ]);
    expect(await reasonOf(service.completeSigner(ctx))).toBe('required_field_unfilled');
    await service.fillField(ctx, ids.get('typed')!, { value: 'A. Rivera' });
    await service.completeSigner(ctx);
    const name = await prisma.signatureField.findUniqueOrThrow({ where: { id: ids.get('name')! } });
    expect(name).toMatchObject({ value: 'Alex Rivera', signature_method: null });
    expect(name.filled_at).not.toBeNull();
    expect((await prisma.signatureField.findUniqueOrThrow({ where: { id: ids.get('typed')! } })).value).toBe('A. Rivera');
  });

  it('a HOSTED session fills the SIGNER_PROFILE name with the attested name when the attested-name port answers', async () => {
    const asked: string[] = [];
    const hosted = new EsignService(prisma, repo, new SoftwareEvidenceManifestSigner(), undefined, {
      attestedName: async (q) => {
        asked.push(q.signer_id);
        return 'Alexandra Rivera';
      },
    });
    const { ctx, ids, signerId } = await signerA([{ key: 'name', field_type: 'SIGNER_NAME', name_mode: 'SIGNER_PROFILE' }], hosted);
    expect((await hosted.getSignerDocumentView(ctx)).fields[0]).toMatchObject({ value: 'Alexandra Rivera', server_filled: true });
    await hosted.completeSigner(ctx);
    expect((await prisma.signatureField.findUniqueOrThrow({ where: { id: ids.get('name')! } })).value).toBe('Alexandra Rivera');
    expect(asked.every((id) => id === signerId)).toBe(true);
  });

  it('the migration’s type-scoped CHECKs refuse configuration on the wrong type or an incoherent group', async () => {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Checks', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({ tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'c.pdf', source_sha256: 'seed', ordinal: 1 });
    const insert = (field_type: string, cols: string, vals: unknown[]) =>
      db.query(
        `INSERT INTO "sign"."SignatureField" (id, tenant_id, envelope_document_id, field_type, page_number, x, y${cols}) VALUES ($1, $2, $3, $4, 0, 1, 1${vals.map((_, i) => `, $${i + 5}`).join('')})`,
        [randomUUID(), TENANT, doc.id, field_type, ...vals],
      );
    const refused: Array<[string, string, unknown[], string]> = [
      ['TEXT', ', name_mode', ['SIGNER_PROFILE'], 'SignatureField_name_mode_check'],
      ['SIGNER_NAME', ', name_mode', ['SENDER'], 'SignatureField_name_mode_check'],
      ['SIGNATURE', ', label', ['x'], 'SignatureField_label_check'],
      ['CHECKBOX', ', label', [''], 'SignatureField_label_check'],
      ['TEXT', ', group_key, group_rule', ['g', 'SELECT_ANY'], 'SignatureField_group_key_check'],
      ['CHECKBOX', ', group_rule', ['SELECT_ANY'], 'SignatureField_group_rule_check'],
      ['CHECKBOX', ', group_key', ['g'], 'SignatureField_group_rule_check'],
      ['CHECKBOX', ', group_key, group_rule', ['g', 'PICK'], 'SignatureField_group_rule_check'],
      ['CHECKBOX', ', group_key, group_rule, min_selected', ['g', 'SELECT_ONE', 2], 'SignatureField_min_selected_check'],
      ['CHECKBOX', ', group_key, group_rule, min_selected', ['g', 'SELECT_ANY', 0], 'SignatureField_min_selected_check'],
      ['CHECKBOX', ', min_selected', [1], 'SignatureField_min_selected_check'],
    ];
    const outcomes: string[] = [];
    for (const [type, cols, vals] of refused) {
      outcomes.push(await insert(type, cols, vals).then(() => `${type}${cols} accepted`, (e: { constraint?: string }) => e.constraint ?? 'other'));
    }
    expect(outcomes).toEqual(refused.map(([, , , constraint]) => constraint));
    await insert('CHECKBOX', ', label, group_key, group_rule, min_selected', ['I agree', 'g', 'SELECT_ANY', 2]);
    await insert('SIGNER_NAME', ', name_mode', ['SIGNER_ENTERED']);
    await insert('ACKNOWLEDGEMENT', '', []);
  });
});
