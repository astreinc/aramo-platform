import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE } from '@aramo/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../index.js';
import { EsignRepository } from '../lib/esign.repository.js';
import { EsignService } from '../lib/esign.service.js';
import { EsignSenderRepository } from '../lib/sender-workspace.repository.js';
import { SoftwareEvidenceManifestSigner } from '../lib/ports/evidence-manifest-signer.port.js';
import { EnvelopeIllegalTransitionError, EnvelopeNotFoundError } from '../lib/domain/errors.js';

// PX-1 — the sender workspace repository on real Postgres: tenant-scoped reads,
// DRAFT-only authoring (a sent envelope can never be edited), recipient / field
// replacement semantics, and the append-only ledger entries authoring writes.

const ROOT = resolve(__dirname, '../../../..');

function esignMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/esign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('PX-1 sender workspace repository — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let service: EsignService;
  let sender: EsignSenderRepository;

  const TENANT = randomUUID();
  const OTHER_TENANT = randomUUID();
  const USER = randomUUID();

  async function draftWithDoc(tenant = TENANT) {
    const env = await sender.createDraft({ tenant_id: tenant, subject: 'Agreement', created_by: USER });
    const doc = await sender.addDraftDocument({
      tenant_id: tenant,
      envelope_id: env.id,
      actor_ref: USER,
      title: 'Agreement',
      source_object_key: `esign/source/${tenant}/${env.id}/k`,
      content_type: 'application/pdf',
      byte_size: 1000,
      source_sha256: 'a'.repeat(64),
    });
    return { env, doc };
  }

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
    sender = new EsignSenderRepository(prisma, repo);
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  it('creates an OWNED draft document with ordinal and a DOCUMENT_ATTACHED ledger event', async () => {
    const { env, doc } = await draftWithDoc();
    expect(doc).toMatchObject({ source_mode: 'OWNED', ordinal: 0, title: 'Agreement' });
    const second = await sender.addDraftDocument({
      tenant_id: TENANT, envelope_id: env.id, actor_ref: USER, title: 'Exhibit', source_object_key: 'k2',
      content_type: 'application/pdf', byte_size: 10, source_sha256: 'b'.repeat(64),
    });
    expect(second.ordinal).toBe(1);
    const events = await sender.listEnvelopeEvents(TENANT, env.id);
    expect(events.map((e) => e.event_type)).toEqual(['ENVELOPE_CREATED', 'DOCUMENT_ATTACHED', 'DOCUMENT_ATTACHED']);
    expect(events[1]?.actor_ref).toBe(USER);
  });

  it('replaces recipients (keep + update, add, delete with their fields) and fields', async () => {
    const { env, doc } = await draftWithDoc();
    const first = await sender.replaceDraftRecipients({
      tenant_id: TENANT, envelope_id: env.id,
      recipients: [{ name: 'Alex', email: 'alex@x.test' }, { name: 'Priya', email: 'priya@x.test' }],
    });
    expect(first.map((s) => [s.name, s.signing_order])).toEqual([['Alex', 1], ['Priya', 2]]);
    const [alex, priya] = first;
    await sender.replaceDraftFields({
      tenant_id: TENANT, envelope_id: env.id,
      fields: [
        { envelope_document_id: doc.id, signer_id: alex!.id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 100, width: 220, height: 48, required: true },
        { envelope_document_id: doc.id, signer_id: priya!.id, field_type: 'SIGNATURE', page_number: 0, x: 330, y: 100, width: 220, height: 48, required: true },
      ],
    });
    // Drop Priya, rename Alex, add Sam → Priya's field goes with her.
    const next = await sender.replaceDraftRecipients({
      tenant_id: TENANT, envelope_id: env.id,
      recipients: [{ id: alex!.id, name: 'Alex Morgan', email: 'alex@x.test' }, { name: 'Sam', email: 'sam@x.test' }],
    });
    expect(next.map((s) => s.name)).toEqual(['Alex Morgan', 'Sam']);
    expect(next[0]!.id).toBe(alex!.id);
    const detail = await sender.getEnvelopeDetail(TENANT, env.id);
    const fields = detail.documents.flatMap((d) => d.fields);
    expect(fields).toHaveLength(1);
    expect(fields[0]!.signer_id).toBe(alex!.id);
  });

  it('refuses a field bound to another envelope\'s signer and an unknown signer id', async () => {
    const a = await draftWithDoc();
    const b = await draftWithDoc();
    const [bSigner] = await sender.replaceDraftRecipients({ tenant_id: TENANT, envelope_id: b.env.id, recipients: [{ name: 'B', email: 'b@x.test' }] });
    await expect(
      sender.replaceDraftFields({
        tenant_id: TENANT, envelope_id: a.env.id,
        fields: [{ envelope_document_id: a.doc.id, signer_id: bSigner!.id, field_type: 'SIGNATURE', page_number: 0, x: 1, y: 1, width: 10, height: 10, required: true }],
      }),
    ).rejects.toBeInstanceOf(EnvelopeNotFoundError);
    await expect(
      sender.replaceDraftRecipients({ tenant_id: TENANT, envelope_id: a.env.id, recipients: [{ id: randomUUID(), name: 'X', email: 'x@x.test' }] }),
    ).rejects.toBeInstanceOf(EnvelopeNotFoundError);
  });

  it('refuses every authoring write once the envelope is sent (DRAFT-only)', async () => {
    const { env, doc } = await draftWithDoc();
    const [s] = await sender.replaceDraftRecipients({ tenant_id: TENANT, envelope_id: env.id, recipients: [{ name: 'Jane', email: 'jane@x.test' }] });
    await service.send(TENANT, env.id, USER);
    await expect(sender.updateDraft({ tenant_id: TENANT, envelope_id: env.id, subject: 'x' })).rejects.toBeInstanceOf(EnvelopeIllegalTransitionError);
    await expect(sender.replaceDraftRecipients({ tenant_id: TENANT, envelope_id: env.id, recipients: [] })).rejects.toBeInstanceOf(EnvelopeIllegalTransitionError);
    await expect(
      sender.replaceDraftFields({ tenant_id: TENANT, envelope_id: env.id, fields: [{ envelope_document_id: doc.id, signer_id: s!.id, field_type: 'SIGNATURE', page_number: 0, x: 1, y: 1, width: 10, height: 10, required: true }] }),
    ).rejects.toBeInstanceOf(EnvelopeIllegalTransitionError);
    await expect(sender.removeDraftDocument({ tenant_id: TENANT, envelope_id: env.id, document_id: doc.id, actor_ref: USER })).rejects.toBeInstanceOf(EnvelopeIllegalTransitionError);
    await expect(sender.renameDraftDocument({ tenant_id: TENANT, envelope_id: env.id, document_id: doc.id, title: 'y' })).rejects.toBeInstanceOf(EnvelopeIllegalTransitionError);
  });

  it('removes a draft document with its fields and compacts ordinals; reorder needs every id once', async () => {
    const { env, doc } = await draftWithDoc();
    const second = await sender.addDraftDocument({
      tenant_id: TENANT, envelope_id: env.id, actor_ref: USER, title: 'Two', source_object_key: 'k', content_type: 'application/pdf', byte_size: 1, source_sha256: 'c'.repeat(64),
    });
    await sender.reorderDraftDocuments({ tenant_id: TENANT, envelope_id: env.id, order: [second.id, doc.id] });
    let detail = await sender.getEnvelopeDetail(TENANT, env.id);
    expect(detail.documents.map((d) => d.title)).toEqual(['Two', 'Agreement']);
    await expect(sender.reorderDraftDocuments({ tenant_id: TENANT, envelope_id: env.id, order: [doc.id] })).rejects.toBeInstanceOf(EnvelopeIllegalTransitionError);
    await sender.removeDraftDocument({ tenant_id: TENANT, envelope_id: env.id, document_id: second.id, actor_ref: USER });
    detail = await sender.getEnvelopeDetail(TENANT, env.id);
    expect(detail.documents.map((d) => [d.title, d.ordinal])).toEqual([['Agreement', 0]]);
  });

  it('scopes every read to the tenant: another tenant sees nothing and cannot open the envelope', async () => {
    const { env } = await draftWithDoc(OTHER_TENANT);
    const mine = await sender.listEnvelopes({ tenant_id: TENANT, limit: 500 });
    expect(mine.some((e) => e.id === env.id)).toBe(false);
    await expect(sender.getEnvelopeDetail(TENANT, env.id)).rejects.toBeInstanceOf(EnvelopeNotFoundError);
    const theirs = await sender.countByStatus(OTHER_TENANT);
    expect(theirs['DRAFT']).toBe(1);
    const docs = await sender.listTenantDocuments(TENANT, 500);
    expect(docs.some((d) => d.envelope.id === env.id)).toBe(false);
  });

  it('filters the list by status, search text and creator', async () => {
    const { env } = await draftWithDoc();
    await sender.updateDraft({ tenant_id: TENANT, envelope_id: env.id, subject: 'Vendor NDA — BluePeak' });
    await sender.replaceDraftRecipients({ tenant_id: TENANT, envelope_id: env.id, recipients: [{ name: 'Sam Rivera', email: 'sam@bluepeak.test' }] });
    expect((await sender.listEnvelopes({ tenant_id: TENANT, q: 'bluepeak', limit: 50 })).map((e) => e.id)).toContain(env.id);
    expect((await sender.listEnvelopes({ tenant_id: TENANT, q: 'sam rivera', limit: 50 })).map((e) => e.id)).toContain(env.id);
    expect((await sender.listEnvelopes({ tenant_id: TENANT, statuses: ['COMPLETED'], limit: 50 })).map((e) => e.id)).not.toContain(env.id);
    expect((await sender.listEnvelopes({ tenant_id: TENANT, created_by: randomUUID(), limit: 50 })).length).toBe(0);
  });
});
