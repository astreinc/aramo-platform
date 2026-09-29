import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../index.js';
import { EsignRepository } from '../lib/esign.repository.js';
import { EsignService } from '../lib/esign.service.js';
import { SoftwareEvidenceManifestSigner } from '../lib/ports/evidence-manifest-signer.port.js';
import { DisclosureNotAcceptedError, SigningSessionInvalidError } from '../lib/domain/errors.js';

// PX-V1 F3 — signer-scoped document view + source descriptor. At baseline the
// signing surface exposed only 3 ids from exchange; this proves the signer can
// now retrieve positioned fields + document metadata (disclosure-gated, no tenant
// leak) and that the server-side source descriptor resolves for the session.

const ROOT = resolve(__dirname, '../../../..');

function esignMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/esign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('PX-V1 F3 signer document view — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let service: EsignService;

  const TENANT = randomUUID();
  const ACTOR = randomUUID();

  async function buildSentEnvelope(): Promise<{ envelopeId: string; docId: string; rawToken: string }> {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Agreement', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({
      tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(),
      title: 'agreement.pdf', source_sha256: 'seed', ordinal: 1,
    });
    const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'jane@x.com', name: 'Jane', signing_order: 1 });
    await repo.addField({ tenant_id: TENANT, envelope_document_id: doc.id, signer_id: signer.id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 120, required: true });
    await repo.addField({ tenant_id: TENANT, envelope_document_id: doc.id, signer_id: signer.id, field_type: 'SIGN_DATE', page_number: 0, x: 72, y: 150, required: true });
    const { sessions } = await service.send(TENANT, env.id, ACTOR);
    return { envelopeId: env.id, docId: doc.id, rawToken: sessions[0]!.raw_token };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17').start();
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

  it('returns positioned fields + document metadata after disclosure, with no tenant leak', async () => {
    const { docId, rawToken } = await buildSentEnvelope();
    const ctx = await service.exchangeToken(rawToken);
    await service.acceptDisclosure(ctx, { disclosure_version: 'v1', disclosure_text_hash: 'dh1' });

    const view = await service.getSignerDocumentView(ctx);
    expect(view.documents).toHaveLength(1);
    expect(view.documents[0]).toMatchObject({ document_id: docId, title: 'agreement.pdf', ordinal: 1 });
    expect(view.fields).toHaveLength(2);
    // Sorted by page/y/x → SIGNATURE (y120) before SIGN_DATE (y150).
    expect(view.fields[0]).toMatchObject({ document_id: docId, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 120, required: true });
    expect(view.fields[1]).toMatchObject({ field_type: 'SIGN_DATE', y: 150 });
    // The decisive privacy invariant: the client-facing view carries no tenant id.
    expect(JSON.stringify(view)).not.toContain(TENANT);
  });

  it('gates the document view behind disclosure acceptance', async () => {
    const { rawToken } = await buildSentEnvelope();
    const ctx = await service.exchangeToken(rawToken);
    await expect(service.getSignerDocumentView(ctx)).rejects.toBeInstanceOf(DisclosureNotAcceptedError);
  });

  it('resolves a server-side source descriptor (CORE_REF) and rejects an unknown document', async () => {
    const { docId, rawToken } = await buildSentEnvelope();
    const ctx = await service.exchangeToken(rawToken);
    await service.acceptDisclosure(ctx, { disclosure_version: 'v1', disclosure_text_hash: 'dh1' });

    const desc = await service.resolveSignerSource(ctx, docId);
    expect(desc).toMatchObject({ tenant_id: TENANT, source_mode: 'CORE_REF', content_type: 'application/pdf' });
    await expect(service.resolveSignerSource(ctx, randomUUID())).rejects.toBeInstanceOf(SigningSessionInvalidError);
  });

  it('rejects an invalid token before any read', async () => {
    await expect(service.resolveSession('not-a-real-token')).rejects.toBeInstanceOf(SigningSessionInvalidError);
  });
});
