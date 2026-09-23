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
import { hashSigningToken } from '../lib/signing-token.js';
import {
  EnvelopeIllegalTransitionError,
  SignatureFieldIncompleteError,
  SigningSessionInvalidError,
} from '../lib/domain/errors.js';

// DOC-3 boundary 2-4 — full E-Sign lifecycle on real Postgres 17: create -> send
// -> exchange capability token -> accept disclosure -> fill field -> complete ->
// COMPLETED + evidence manifest. Plus state-machine guards + raw-token-never-stored.

const ROOT = resolve(__dirname, '../../../..');

function esignMigrations(): string[] {
  const dir = resolve(ROOT, 'libs/esign/prisma/migrations');
  return readdirSync(dir).filter((n) => /^\d/.test(n)).sort().map((n) => resolve(dir, n, 'migration.sql'));
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('DOC-3 E-Sign lifecycle — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  let repo: EsignRepository;
  let service: EsignService;

  const TENANT = randomUUID();
  const ACTOR = randomUUID();

  async function buildDraftEnvelope(): Promise<{ envelopeId: string; signerId: string; fieldId: string }> {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Offer', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    const doc = await repo.addDocument({
      tenant_id: TENANT, envelope_id: env.id, document_ref: randomUUID(), document_revision_ref: randomUUID(),
      title: 'offer.pdf', source_sha256: 'abc', ordinal: 1,
    });
    const signer = await repo.addSigner({ tenant_id: TENANT, envelope_id: env.id, email: 'jane@x.com', name: 'Jane', signing_order: 1 });
    const field = await repo.addField({
      tenant_id: TENANT, envelope_document_id: doc.id, signer_id: signer.id, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 120, required: true,
    });
    return { envelopeId: env.id, signerId: signer.id, fieldId: field.id };
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

  it('runs the full lifecycle to COMPLETED with a verifiable evidence manifest', async () => {
    const { envelopeId } = await buildDraftEnvelope();
    const { sessions } = await service.send(TENANT, envelopeId, ACTOR);
    expect(sessions).toHaveLength(1);
    const raw = sessions[0]!.raw_token;

    // Raw token is never stored — only its hash exists in the row.
    const stored = await db.query(`SELECT token_hash FROM "esign"."SigningSession" WHERE id = $1`, [sessions[0]!.session_id]);
    expect(stored.rows[0].token_hash).toBe(hashSigningToken(raw));
    const rawLeak = await db.query(`SELECT count(*)::int AS n FROM "esign"."SigningSession" WHERE token_hash = $1`, [raw]);
    expect(rawLeak.rows[0].n).toBe(0); // the raw token is not a stored value

    const ctx = await service.exchangeToken(raw);
    expect(ctx.envelope_id).toBe(envelopeId);
    // Exchange moved the envelope to IN_PROGRESS.
    const mid = await repo.getEnvelope(TENANT, envelopeId);
    expect(mid.status).toBe('IN_PROGRESS');

    await service.acceptDisclosure(ctx, { disclosure_version: 'v1', disclosure_text_hash: 'dh1', ip_address: '1.2.3.4', user_agent: 'UA' });
    const field = await db.query(`SELECT id FROM "esign"."SignatureField" WHERE tenant_id=$1 AND signer_id=$2`, [TENANT, ctx.signer_id]);
    await service.fillField(ctx, field.rows[0].id, { value: 'Jane Doe', signature_method: 'TYPED' });
    const result = await service.completeSigner(ctx);
    expect(result.envelope_status).toBe('COMPLETED');

    const manifest = await service.evidenceManifest(TENANT, envelopeId);
    expect(manifest.signature_algorithm).toBe(SoftwareEvidenceManifestSigner.ALGORITHM);
    expect(manifest.manifest.event_chain_hash).toMatch(/.+/);
    expect(await new SoftwareEvidenceManifestSigner().verify(manifest)).toBe(true);
  });

  it('rejects completing a signer with an unfilled required field', async () => {
    const { envelopeId } = await buildDraftEnvelope();
    const { sessions } = await service.send(TENANT, envelopeId, ACTOR);
    const ctx = await service.exchangeToken(sessions[0]!.raw_token);
    await service.acceptDisclosure(ctx, { disclosure_version: 'v1', disclosure_text_hash: 'dh1' });
    await expect(service.completeSigner(ctx)).rejects.toBeInstanceOf(SignatureFieldIncompleteError);
  });

  it('rejects sending an envelope with no signers (illegal/invalid)', async () => {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'Empty', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    await expect(service.send(TENANT, env.id, ACTOR)).rejects.toBeInstanceOf(SigningSessionInvalidError);
  });

  it('rejects an unknown capability token', async () => {
    await expect(service.exchangeToken('not-a-real-token')).rejects.toBeInstanceOf(SigningSessionInvalidError);
  });

  it('void from DRAFT is allowed; a terminal envelope rejects further transitions', async () => {
    const env = await repo.createEnvelope({ tenant_id: TENANT, subject: 'V', execution_mode: 'SINGLE_SIGNATURE', created_by: ACTOR });
    await service.voidEnvelope(TENANT, env.id, ACTOR, 'no longer needed');
    const voided = await repo.getEnvelope(TENANT, env.id);
    expect(voided.status).toBe('VOIDED');
    await expect(service.voidEnvelope(TENANT, env.id, ACTOR, 'again')).rejects.toBeInstanceOf(EnvelopeIllegalTransitionError);
  });

  it('maintains a linked hash chain across the lifecycle events', async () => {
    const { envelopeId } = await buildDraftEnvelope();
    await service.send(TENANT, envelopeId, ACTOR);
    const events = await repo.listEvents(TENANT, envelopeId);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]!.previous_event_hash).toBeNull();
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.previous_event_hash).toBe(events[i - 1]!.event_hash);
    }
  });
});
