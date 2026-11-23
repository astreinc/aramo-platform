import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EsignSenderRepository, PrismaService } from '../index.js';
import { EsignRepository } from '../lib/esign.repository.js';
import { EsignService, type SessionContext } from '../lib/esign.service.js';
import { currentDisclosure } from '../lib/domain/disclosure.js';
import { SoftwareEvidenceManifestSigner } from '../lib/ports/evidence-manifest-signer.port.js';
import { SignatureFieldIncompleteError, SignatureFieldValueRefusedError } from '../lib/domain/errors.js';

// FIELD-PARITY-2 (Aramo-Sign-Field-Placement-Conditional-Fields-Directive-v1_0-LOCKED) §4 Phase B,
// §5 test 3, on real Postgres 17 with every sign migration (incl. 20261123100000_field_parity_2_field_key
// and 20261123100100_field_parity_2_field_condition). Skipped unless ARAMO_RUN_INTEGRATION=1 (CI).
//   - the migrations: the field_key CHECK and per-document partial unique index; the condition
//     shape CHECK; both re-run cleanly and leave existing rows NULL;
//   - the sender save (replaceDraftFields): keys and conditions survive re-saves (row ids do not);
//   - the template carry (bindTemplateDraft): the template key is the envelope key, with its condition;
//   - fill: a hidden field is refused (field_hidden); unticking a trigger clears its dependents
//     along the chain in the same transaction (C-3); a radio re-choice clears what it showed;
//   - completion: a hidden required field never blocks; a hidden SIGN_DATE is never stamped; the
//     signer view carries field_key and condition.
// JSONB values go to node-pg as JSON text (JSON.stringify): node-pg sends a JS array as a Postgres
// array literal.

const ROOT = resolve(__dirname, '../../../..');
const DISCLOSURE = currentDisclosure();

function esignMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/sign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

type FieldSpec = { key: string; field_type: string; required?: boolean; data?: Record<string, unknown> };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('FIELD-PARITY-2 Phase B — field keys and conditional fields — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let sender: EsignSenderRepository;
  let service: EsignService;
  const TENANT = randomUUID();
  const ACTOR = randomUUID();

  // Two signers, so A's completion leaves the envelope IN_PROGRESS. B's signature sits at
  // (300, 300); A's fields run down x = 72 from y = 90, 30 points apart (no overlap).
  async function signer(fields: FieldSpec[]): Promise<{ ctx: SessionContext; ids: Map<string, string> }> {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'FP2', execution_mode: 'MULTI_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({ tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'fp2.pdf', source_sha256: 'seed', ordinal: 1 });
    const a = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'alex@x.com', name: 'Alex Rivera', signing_order: 1 });
    const b = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'blake@x.com', name: 'Blake', signing_order: 2 });
    await repo.addField({ tenant_id: TENANT, envelope_document_id: doc.id, signer_id: b.id, field_type: 'SIGNATURE', page_number: 0, x: 300, y: 300, required: true });
    const ids = new Map<string, string>();
    let y = 60;
    for (const f of fields) {
      const row = await repo.addField({ tenant_id: TENANT, envelope_document_id: doc.id, signer_id: a.id, field_type: 'TEXT', page_number: 0, x: 72, y: (y += 30), width: 150, height: 22, required: f.required ?? true });
      await prisma.signatureField.update({ where: { id: row.id }, data: { field_type: f.field_type, field_key: f.key, ...(f.data ?? {}) } as never });
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
  const row = (id: string) => prisma.signatureField.findUniqueOrThrow({ where: { id } });

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

  it('the migrations: field_key length CHECK and per-document uniqueness; the condition shape CHECK', async () => {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Checks', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({ tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'c.pdf', source_sha256: 'seed', ordinal: 1 });
    const doc2 = await repo.addDocument({ tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(), title: 'd.pdf', source_sha256: 'seed', ordinal: 2 });
    const insert = (docId: string, key: string | null, condition: unknown) =>
      db.query(
        `INSERT INTO "sign"."SignatureField" (id, tenant_id, envelope_document_id, field_type, page_number, x, y, field_key, condition) VALUES ($1, $2, $3, 'TEXT', 0, 1, 1, $4, $5::jsonb)`,
        [randomUUID(), TENANT, docId, key, condition === null ? null : JSON.stringify(condition)],
      );
    const outcome = (p: Promise<unknown>) => p.then(() => 'accepted', (e: { constraint?: string }) => e.constraint ?? 'other');

    const refused: Array<[string | null, unknown, string]> = [
      ['', null, 'SignatureField_field_key_check'],
      ['x'.repeat(201), null, 'SignatureField_field_key_check'],
      [null, 'checked', 'SignatureField_condition_check'],
      [null, ['checked'], 'SignatureField_condition_check'],
      [null, { when: 'checked' }, 'SignatureField_condition_check'],
      [null, { trigger_key: '', when: 'checked' }, 'SignatureField_condition_check'],
      [null, { trigger_key: 't', when: 'is' }, 'SignatureField_condition_check'],
      [null, { trigger_key: 't', when: 'checked', values: ['a'] }, 'SignatureField_condition_check'],
      [null, { trigger_key: 't', when: 'one_of' }, 'SignatureField_condition_check'],
      [null, { trigger_key: 't', when: 'one_of', values: [] }, 'SignatureField_condition_check'],
      [null, { trigger_key: 't', when: 'one_of', values: [1] }, 'SignatureField_condition_check'],
      [null, { trigger_key: 't', when: 'one_of', values: Array.from({ length: 51 }, (_, i) => `v${i}`) }, 'SignatureField_condition_check'],
      [null, { trigger_key: 't', when: 'checked', and: 'u' }, 'SignatureField_condition_check'],
    ];
    const outcomes: string[] = [];
    for (const [key, condition] of refused) outcomes.push(await outcome(insert(doc.id, key, condition)));
    expect(outcomes).toEqual(refused.map(([, , c]) => c));

    for (const condition of [{ trigger_key: 't', when: 'checked' }, { trigger_key: 't', when: 'unchecked' }, { trigger_key: 't', when: 'chosen' }, { trigger_key: 't', when: 'one_of', values: ['a', 'b'] }]) {
      expect(await outcome(insert(doc.id, null, condition))).toBe('accepted');
    }
    // A key is unique per document when present; NULL keys never collide; the same key on another
    // document is the shared rule's to refuse (per envelope), not the index's.
    expect(await outcome(insert(doc.id, 'k1', null))).toBe('accepted');
    expect(await outcome(insert(doc.id, 'k1', null))).toBe('SignatureField_document_field_key');
    expect(await outcome(insert(doc.id, null, null))).toBe('accepted');
    expect(await outcome(insert(doc.id, null, null))).toBe('accepted');
    expect(await outcome(insert(doc2.id, 'k1', null))).toBe('accepted');
  });

  it('the migrations re-run cleanly and leave existing rows NULL', async () => {
    for (const m of ['20261123100000_field_parity_2_field_key', '20261123100100_field_parity_2_field_condition']) {
      const sql = readFileSync(resolve(ROOT, `libs/sign/prisma/migrations/${m}/migration.sql`), 'utf8');
      await db.query(sql);
      await db.query(sql);
    }
    const legacy = await db.query(`SELECT count(*)::int AS n FROM "sign"."SignatureField" WHERE tenant_id = $1 AND field_type = 'SIGNATURE' AND (field_key IS NOT NULL OR condition IS NOT NULL)`, [TENANT]);
    expect(legacy.rows[0]).toEqual({ n: 0 });
  });

  it('sender save: the key and the condition survive re-saves; the row ids do not', async () => {
    const d = await sender.createDraft({ tenant_id: TENANT, subject: 'Keys', created_by: ACTOR });
    const [s1] = await sender.replaceDraftRecipients({ tenant_id: TENANT, envelope_id: d.id, recipients: [{ name: 'Alex', email: 'alex@x.com' }] });
    const doc = await sender.addDraftCoreRefDocument({ tenant_id: TENANT, envelope_id: d.id, actor_ref: ACTOR, title: 'f.pdf', document_ref: randomUUID(), document_revision_ref: randomUUID(), source_sha256: 'seed' });
    const base = { envelope_document_id: doc.id, signer_id: s1!.id, page_number: 0, x: 10, width: 120, height: 22, required: true };
    const fields = [
      { ...base, y: 10, field_type: 'SIGNATURE', field_key: 'sig' },
      { ...base, y: 60, width: 14, height: 14, required: false, field_type: 'CHECKBOX', field_key: 'agree' },
      { ...base, y: 110, field_type: 'TEXT', field_key: 'detail', condition: { trigger_key: 'agree', when: 'checked' } },
    ];
    await sender.replaceDraftFields({ tenant_id: TENANT, envelope_id: d.id, actor_ref: ACTOR, fields });
    const first = await prisma.signatureField.findMany({ where: { envelope_document_id: doc.id }, orderBy: { y: 'asc' } });
    await sender.replaceDraftFields({ tenant_id: TENANT, envelope_id: d.id, actor_ref: ACTOR, fields });
    const second = await prisma.signatureField.findMany({ where: { envelope_document_id: doc.id }, orderBy: { y: 'asc' } });
    expect(second.map((f) => f.field_key)).toEqual(['sig', 'agree', 'detail']);
    expect(second[2]).toMatchObject({ condition: { trigger_key: 'agree', when: 'checked' } });
    expect(second.map((f) => f.id)).not.toEqual(first.map((f) => f.id));
  });

  it('template carry: the template field_key is the envelope key, with its condition', async () => {
    const d = await sender.createDraft({ tenant_id: TENANT, subject: 'Carry', created_by: ACTOR });
    const doc = await sender.addDraftCoreRefDocument({ tenant_id: TENANT, envelope_id: d.id, actor_ref: ACTOR, title: 't.pdf', document_ref: randomUUID(), document_revision_ref: randomUUID(), source_sha256: 'seed' });
    const base = { envelope_document_id: doc.id, role_key: 'client', page_number: 0, x: 10, width: 120, height: 22, required: false };
    await sender.bindTemplateDraft({
      tenant_id: TENANT,
      envelope_id: d.id,
      routing_mode: 'PARALLEL',
      message: null,
      recipients: [{ role_key: 'client', name: 'Client', email: 'client@x.com', signing_order: 1, recipient_kind: 'SIGNER' }],
      fields: [
        { ...base, y: 10, field_type: 'SIGNATURE', required: true },
        { ...base, y: 60, width: 14, height: 14, field_type: 'CHECKBOX', field_key: 'agree' },
        { ...base, y: 110, field_type: 'TEXT', field_key: 'detail', condition: { trigger_key: 'agree', when: 'checked' } },
      ],
    });
    const rows = await prisma.signatureField.findMany({ where: { envelope_document_id: doc.id }, orderBy: { y: 'asc' } });
    expect(rows.map((r) => [r.field_key, r.condition])).toEqual([
      [null, null],
      ['agree', null],
      ['detail', { trigger_key: 'agree', when: 'checked' }],
    ]);
  });

  it('fill: a hidden field is refused; the signer view carries field_key and condition', async () => {
    const { ctx, ids } = await signer([
      { key: 'agree', field_type: 'CHECKBOX', required: false },
      { key: 'detail', field_type: 'TEXT', data: { condition: { trigger_key: 'agree', when: 'checked' } } },
      { key: 'typed', field_type: 'TEXT', required: false },
    ]);
    const view = await service.getSignerDocumentView(ctx);
    expect(view.fields.find((f) => f.field_id === ids.get('detail'))).toMatchObject({ field_key: 'detail', condition: { trigger_key: 'agree', when: 'checked' } });
    expect(view.fields.find((f) => f.field_id === ids.get('agree'))).toMatchObject({ field_key: 'agree', condition: null });
    expect(await reasonOf(service.fillField(ctx, ids.get('detail')!, { value: 'x' }))).toBe('field_hidden');
    await service.fillField(ctx, ids.get('agree')!, { value: 'true' });
    await service.fillField(ctx, ids.get('detail')!, { value: 'x' });
    expect((await row(ids.get('detail')!)).value).toBe('x');
  });

  it('cleared on hide: unticking a trigger clears its chain in the same transaction (C-3); a radio re-choice too', async () => {
    const { ctx, ids } = await signer([
      { key: 'a', field_type: 'CHECKBOX', required: false },
      { key: 'b', field_type: 'CHECKBOX', required: false, data: { condition: { trigger_key: 'a', when: 'checked' } } },
      { key: 'c', field_type: 'TEXT', required: false, data: { condition: { trigger_key: 'b', when: 'checked' } } },
      { key: 'yes', field_type: 'RADIO', required: false, data: { group_key: 'g', group_rule: 'SELECT_ONE', label: 'Yes' } },
      { key: 'no', field_type: 'RADIO', required: false, data: { group_key: 'g', group_rule: 'SELECT_ONE', label: 'No' } },
      { key: 'why', field_type: 'TEXT', required: false, data: { condition: { trigger_key: 'yes', when: 'chosen' } } },
      { key: 'typed', field_type: 'TEXT', required: false },
    ]);
    await service.fillField(ctx, ids.get('a')!, { value: 'true' });
    await service.fillField(ctx, ids.get('b')!, { value: 'true' });
    await service.fillField(ctx, ids.get('c')!, { value: 'typed' });
    await service.fillField(ctx, ids.get('a')!, { value: 'false' });
    expect(await row(ids.get('b')!)).toMatchObject({ value: null, filled_at: null });
    expect(await row(ids.get('c')!)).toMatchObject({ value: null, filled_at: null });

    await service.fillField(ctx, ids.get('yes')!, { value: 'true' });
    await service.fillField(ctx, ids.get('why')!, { value: 'because' });
    await service.fillField(ctx, ids.get('no')!, { value: 'true' });
    expect(await row(ids.get('why')!)).toMatchObject({ value: null, filled_at: null });
  });

  it('completion: a hidden required field never blocks; a hidden SIGN_DATE is not stamped; shown, it is required', async () => {
    const { ctx, ids } = await signer([
      { key: 'agree', field_type: 'CHECKBOX', required: false },
      { key: 'detail', field_type: 'TEXT', required: true, data: { condition: { trigger_key: 'agree', when: 'checked' } } },
      { key: 'date', field_type: 'SIGN_DATE', required: true, data: { condition: { trigger_key: 'agree', when: 'checked' } } },
      { key: 'typed', field_type: 'TEXT' },
    ]);
    await service.fillField(ctx, ids.get('typed')!, { value: 'typed' });
    await service.fillField(ctx, ids.get('agree')!, { value: 'true' });
    expect(await reasonOf(service.completeSigner(ctx))).toBe('required_field_unfilled');
    await service.fillField(ctx, ids.get('agree')!, { value: 'false' });
    await service.completeSigner(ctx);
    expect(await row(ids.get('date')!)).toMatchObject({ value: null, filled_at: null });
    expect(await row(ids.get('detail')!)).toMatchObject({ value: null });
  });
});
